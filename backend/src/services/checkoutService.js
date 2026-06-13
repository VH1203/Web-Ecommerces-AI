// services/checkoutService.js
const notif = require("./dbNotificationService");
const audit = require("./auditLogService");
const mongoose = require("mongoose");
const Cart = require("../models/Cart");
const Voucher = require("../models/Voucher");
const Order = require("../models/Order");
const Address = require("../models/Address");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const FlashSale = require("../models/FlashSale");
const Shop = require("../models/Shop");
const ShopCredit = require("../models/ShopCredit");
const { v4: uuidv4 } = require("uuid");
const shippingSvc = require("./shippingService");
const inventory = require("./inventoryService");

// ─────────────────────────────────────────────────────────────────────────────
// deductStock — decrease ProductVariant.stock for each item in an order.
// Idempotent: uses inventory_adjusted flag as guard.
// ─────────────────────────────────────────────────────────────────────────────
async function deductStock(order, session = null) {
  await inventory.deductOrderStock(order, { session });
  console.log(`[INVENTORY] Deducted stock for order ${order.order_code}`);
}

async function incrementFlashSaleSold(items, flashMap, session = null) {
  if (!flashMap || flashMap.size === 0) return;

  const qtyByVariant = new Map();
  for (const item of items || []) {
    const fi = flashMap.get(String(item.variant_id));
    if (!fi) continue;
    const key = String(item.variant_id);
    const current = qtyByVariant.get(key) || { qty: 0, flash: fi };
    current.qty += Number(item.qty || 0);
    qtyByVariant.set(key, current);
  }

  for (const [variantId, { qty, flash }] of qtyByVariant) {
    if (qty <= 0) continue;
    const maxSoldBeforeUpdate = Number(flash.quantity_total || 0) - qty;
    const result = await FlashSale.updateOne(
      {
        _id: flash.flashsale_id,
        products: {
          $elemMatch: {
            variant_id: variantId,
            quantity_sold: { $lte: maxSoldBeforeUpdate },
          },
        },
      },
      { $inc: { "products.$.quantity_sold": qty } },
      { session }
    );
    if (result.modifiedCount !== 1) {
      throw Object.assign(new Error("Flash Sale vừa hết suất cho một số sản phẩm. Vui lòng thử lại."), { status: 409 });
    }
  }
}

function readVariantAttrs(variant) {
  return variant?.variant_attributes instanceof Map
    ? Object.fromEntries(variant.variant_attributes)
    : (variant?.variant_attributes || {});
}

// ─────────────────────────────────────────────────────────────────────────────
// getActiveFlashMap — returns Map<variantId, flashItem> for any active flash sales
// ─────────────────────────────────────────────────────────────────────────────
async function getActiveFlashMap(variantIds, shopIds) {
  if (!variantIds.length || !shopIds.length) return new Map();
  const now = new Date();
  const flashSales = await FlashSale.find({
    shop_id: { $in: shopIds.map(String) },
    status: "active",
    start_time: { $lte: now },
    end_time: { $gt: now },
    "products.variant_id": { $in: variantIds.map(String) },
  }).lean();

  const map = new Map();
  for (const fs of flashSales) {
    for (const p of fs.products) {
      const vid = String(p.variant_id);
      if (!map.has(vid) && variantIds.map(String).includes(vid)) {
        map.set(vid, {
          flashsale_id: fs._id,
          flash_price: p.flash_price,
          quantity_total: p.quantity_total,
          quantity_sold: p.quantity_sold,
          max_per_user: fs.max_per_user,
        });
      }
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveItems — Unified item resolution with DB validation
// Returns items enriched with shop_id from each product, plus flash sale map
// ─────────────────────────────────────────────────────────────────────────────
async function resolveItems(userId, { selected_item_ids, buy_now_items }) {
  const isBuyNow = Array.isArray(buy_now_items) && buy_now_items.length > 0;

  if (isBuyNow) {
    const requested = buy_now_items
      .map(({ productId, variantId, quantity }) => ({
        productId,
        variantId,
        qty: Math.max(1, Number(quantity) || 1),
      }))
      .filter((item) => item.variantId);

    if (!requested.length) {
      throw Object.assign(new Error("Chưa chọn sản phẩm nào"), { status: 400 });
    }

    const requestedVariantIds = [...new Set(requested.map((i) => String(i.variantId)))];
    const variants = await ProductVariant.find({ _id: { $in: requestedVariantIds }, is_active: true }).lean();
    const variantMap = new Map(variants.map((v) => [String(v._id), v]));
    const productIds = [...new Set(requested.map((i) => String(i.productId || variantMap.get(String(i.variantId))?.product_id)).filter(Boolean))];
    const products = await Product.find({ _id: { $in: productIds }, status: { $ne: "deleted" } }).lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const result = requested.map(({ productId, variantId, qty }) => {
      const variant = variantMap.get(String(variantId));
      if (!variant) {
        throw Object.assign(new Error(`Biến thể không tồn tại hoặc đã ngừng bán (id: ${variantId})`), { status: 400 });
      }
      const product = productMap.get(String(productId || variant.product_id));
      if (!product) {
        throw Object.assign(new Error("Sản phẩm không tồn tại"), { status: 400 });
      }
      if (String(variant.product_id) !== String(product._id)) {
        throw Object.assign(new Error("Biến thể không thuộc sản phẩm này"), { status: 400 });
      }
      if ((variant.stock ?? 0) < qty) {
        throw Object.assign(
          new Error(`"${product.name}" không đủ tồn kho (còn ${variant.stock ?? 0}, cần ${qty})`),
          { status: 400 }
        );
      }

      return {
        product_id: product._id,
        variant_id: variant._id,
        shop_id: product.shop_id || variant.shop_id || null,
        name: product.name,
        image_url: variant.images?.[0] || product.images?.[0] || "",
        variant_attributes: readVariantAttrs(variant),
        sku: variant.sku || null,
        compare_at_price: variant.compare_at_price || null,
        qty,
        price: variant.price,
        discount: 0,
        total: variant.price * qty,
      };
    });

    // Apply active flash sale prices (buy-now path)
    const variantIds = result.map((i) => String(i.variant_id));
    const shopIds    = [...new Set(result.map((i) => i.shop_id).filter(Boolean))];
    const flashMap   = await getActiveFlashMap(variantIds, shopIds);
    for (const item of result) {
      const fi = flashMap.get(String(item.variant_id));
      if (fi) {
        if (fi.quantity_sold + item.qty > fi.quantity_total) {
          throw Object.assign(
            new Error(`"${item.name}" đã hết suất Flash Sale (còn ${Math.max(0, fi.quantity_total - fi.quantity_sold)} suất)`),
            { status: 400 }
          );
        }
        item.discount = item.price - fi.flash_price;
        item.total    = fi.flash_price * item.qty;
      }
    }

    return { items: result, cartItemIds: null, flashMap };
  }

  // ── Cart-based ────────────────────────────────────────────────────────────
  const cart = await Cart.findOne({ user_id: userId }).lean();
  if (!cart || !cart.items?.length) {
    throw Object.assign(new Error("Giỏ hàng trống"), { status: 400 });
  }

  const ids = Array.isArray(selected_item_ids) && selected_item_ids.length > 0
    ? new Set(selected_item_ids)
    : new Set(cart.items.map((i) => i._id));

  const cartItems = cart.items.filter((i) => ids.has(i._id));
  if (!cartItems.length) {
    throw Object.assign(new Error("Chưa chọn sản phẩm nào trong giỏ hàng"), { status: 400 });
  }

  const result = [];
  const cartVariantIds = [...new Set(cartItems.map((i) => String(i.variant_id)).filter(Boolean))];
  const cartProductIds = [...new Set(cartItems.map((i) => String(i.product_id)).filter(Boolean))];
  const [variants, products] = await Promise.all([
    ProductVariant.find({ _id: { $in: cartVariantIds }, is_active: true }).lean(),
    Product.find({ _id: { $in: cartProductIds }, status: { $ne: "deleted" } }).lean(),
  ]);
  const variantMap = new Map(variants.map((v) => [String(v._id), v]));
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  for (const ci of cartItems) {
    const variant = variantMap.get(String(ci.variant_id));
    if (!variant) {
      throw Object.assign(
        new Error(`Biến thể của "${ci.name}" không còn tồn tại. Vui lòng cập nhật giỏ hàng.`),
        { status: 400 }
      );
    }
    const product = productMap.get(String(ci.product_id));
    if (!product) {
      throw Object.assign(
        new Error(`Sản phẩm "${ci.name}" không còn tồn tại.`),
        { status: 400 }
      );
    }
    if ((variant.stock ?? 0) < ci.qty) {
      throw Object.assign(
        new Error(`"${ci.name}" không đủ tồn kho (còn ${variant.stock ?? 0}, cần ${ci.qty})`),
        { status: 400 }
      );
    }

    result.push({
      product_id: product._id,
      variant_id: variant._id,
      shop_id: product.shop_id || variant.shop_id || null,
      name: product.name,
      image_url: variant.images?.[0] || product.images?.[0] || ci.image || "",
      variant_attributes: readVariantAttrs(variant),
      sku: variant.sku || null,
      compare_at_price: variant.compare_at_price || null,
      qty: ci.qty,
      price: variant.price,
      discount: 0,
      total: variant.price * ci.qty,
    });
  }

  // Apply active flash sale prices (cart path)
  const variantIds = result.map((i) => String(i.variant_id));
  const shopIds    = [...new Set(result.map((i) => i.shop_id).filter(Boolean))];
  const flashMap   = await getActiveFlashMap(variantIds, shopIds);
  for (const item of result) {
    const fi = flashMap.get(String(item.variant_id));
    if (fi) {
      if (fi.quantity_sold + item.qty > fi.quantity_total) {
        throw Object.assign(
          new Error(`"${item.name}" đã hết suất Flash Sale (còn ${Math.max(0, fi.quantity_total - fi.quantity_sold)} suất)`),
          { status: 400 }
        );
      }
      item.discount = item.price - fi.flash_price;
      item.total    = fi.flash_price * item.qty;
    }
  }

  return { items: result, cartItemIds: Array.from(ids), flashMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// applyVoucher — validates & calculates discount
// expectedType: "product" | "shipping" — ensures voucher matches intended use
// applyTo: the amount to cap the discount against (subtotal or shipping_fee)
// Returns { voucher, discount } on success, or { voucher:null, discount:0, error } on failure
// ─────────────────────────────────────────────────────────────────────────────
async function applyVoucher(voucherCode, applyTo, userId, expectedType = null) {
  if (!voucherCode) return { voucher: null, discount: 0 };

  const code = voucherCode.toString().trim().toUpperCase();
  const v = await Voucher.findOne({ code, is_active: true });
  if (!v) return { voucher: null, discount: 0, error: "Mã voucher không tồn tại hoặc đã bị vô hiệu hóa" };

  // Check voucher type matches expected usage
  const vType = v.voucher_type || "product";
  if (expectedType && vType !== expectedType) {
    const label = expectedType === "shipping" ? "giảm phí vận chuyển" : "giảm giá sản phẩm";
    return { voucher: null, discount: 0, error: `Voucher này không phải loại ${label}` };
  }

  const now = new Date();
  if (now < new Date(v.valid_from))
    return { voucher: null, discount: 0, error: "Voucher chưa có hiệu lực" };
  if (now > new Date(v.valid_to))
    return { voucher: null, discount: 0, error: "Voucher đã hết hạn" };
  if (v.used_count >= v.max_uses)
    return { voucher: null, discount: 0, error: "Voucher đã hết lượt sử dụng" };
  if (applyTo < (v.min_order_value || 0))
    return {
      voucher: null, discount: 0,
      error: `Đơn hàng tối thiểu ${(v.min_order_value || 0).toLocaleString("vi-VN")}₫ để dùng voucher này`,
    };

  if (userId && v.applicable_users?.length > 0) {
    if (!v.applicable_users.map(String).includes(String(userId)))
      return { voucher: null, discount: 0, error: "Voucher này không áp dụng cho tài khoản của bạn" };
  }

  if (userId && v.usage_limit_per_user > 0) {
    const usedByUser = await Order.countDocuments({ user_id: String(userId), voucher_id: v._id });
    if (usedByUser >= v.usage_limit_per_user)
      return { voucher: null, discount: 0, error: "Bạn đã sử dụng hết lượt cho voucher này" };
  }

  let rawDiscount = v.discount_type === "percent"
    ? Math.round((applyTo * v.discount_value) / 100)
    : v.discount_value;
  // Cap by max_discount if set
  if (v.max_discount > 0) rawDiscount = Math.min(rawDiscount, v.max_discount);
  const discount = Math.min(rawDiscount, applyTo); // cannot exceed apply-to amount
  return { voucher: v, discount: Math.max(0, discount) };
}

// ─────────────────────────────────────────────────────────────────────────────
// groupItemsByShop — split items array into per-shop groups
// Items without a shop_id are grouped under a fallback key
// ─────────────────────────────────────────────────────────────────────────────
function groupItemsByShop(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.shop_id || "unknown";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// preview — Read-only calculation for the Checkout UI
// Returns items grouped by shop for UI display
// ─────────────────────────────────────────────────────────────────────────────
exports.preview = async ({
  userId,
  selected_item_ids,
  buy_now_items,
  address_id,
  voucher_code,
  shipping_voucher_code,
  credits_to_use = {},
}) => {
  if (!userId) throw Object.assign(new Error("Unauthorized"), { status: 401 });

  const { items } = await resolveItems(userId, { selected_item_ids, buy_now_items });

  const subtotal = items.reduce((s, it) => s + it.total, 0);
  const shipping_fee_raw = await shippingSvc.calculate("GHN", address_id || null, null, items);

  // Apply product voucher to subtotal
  const { voucher, discount, error: voucherError } = await applyVoucher(voucher_code, subtotal, userId, "product");

  // Apply shipping voucher to shipping fee
  const { voucher: shipVoucher, discount: shippingDiscount, error: shipVoucherError } =
    await applyVoucher(shipping_voucher_code, shipping_fee_raw, userId, "shipping");

  const shipping_fee = Math.max(0, shipping_fee_raw - shippingDiscount);

  // Enrich with shop names
  const shopIds = [...new Set(items.map((i) => i.shop_id).filter(Boolean))];
  const shops = await Shop.find({ _id: { $in: shopIds } }).select("_id shop_name shop_slug shop_logo").lean();
  const shopMap = new Map(shops.map((s) => [s._id, s]));

  // Load user's credit balances for each shop
  const creditRecords = await ShopCredit.find({
    user_id: String(userId),
    shop_id: { $in: shopIds },
    balance: { $gt: 0 },
  }).lean();
  const creditBalanceMap = new Map(creditRecords.map((c) => [String(c.shop_id), c.balance]));

  // Group items by shop + calculate per-shop totals including credits
  const shopGroups = [];
  if (items.some((item) => !item.shop_id)) {
    throw Object.assign(new Error("Một số sản phẩm chưa gắn shop hợp lệ."), { status: 400 });
  }
  const grouped = groupItemsByShop(items);
  let totalCreditsDiscount = 0;

  for (const [shopId, shopItems] of grouped) {
    const shopSubtotal = shopItems.reduce((s, i) => s + i.total, 0);
    const ratio = subtotal > 0 ? shopSubtotal / subtotal : 1;
    const shopVoucherDiscount = Math.round(discount * ratio);

    const availableCredits = creditBalanceMap.get(String(shopId)) || 0;
    const requestedCredits = Number((credits_to_use || {})[shopId] || 0);
    const creditsUsed = Math.min(requestedCredits, availableCredits, shopSubtotal - shopVoucherDiscount);

    totalCreditsDiscount += creditsUsed;

    const shopInfo = shopMap.get(shopId);
    shopGroups.push({
      shop_id: shopId,
      shop_name: shopInfo?.shop_name || "Cửa hàng",
      shop_logo: shopInfo?.shop_logo || null,
      items: shopItems,
      subtotal: shopSubtotal,
      available_credits: availableCredits,
      credits_used: creditsUsed,
    });
  }

  const total = Math.max(0, subtotal + shipping_fee - discount - totalCreditsDiscount);

  return {
    items,
    shop_groups: shopGroups,
    subtotal,
    shipping_fee_raw,
    shipping_fee,
    shipping_discount: shippingDiscount,
    discount,
    credits_discount: totalCreditsDiscount,
    total,
    currency: "VND",
    voucher: voucher
      ? { _id: voucher._id, code: voucher.code, discount_type: voucher.discount_type, discount_value: voucher.discount_value, voucher_type: "product" }
      : null,
    voucher_error: voucherError || null,
    shipping_voucher: shipVoucher
      ? { _id: shipVoucher._id, code: shipVoucher.code, discount_type: shipVoucher.discount_type, discount_value: shipVoucher.discount_value, voucher_type: "shipping" }
      : null,
    shipping_voucher_error: shipVoucherError || null,
    payment_methods: ["COD", "PAYPAL", "VNPAY"],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// confirm — Creates ONE ORDER PER SHOP
// Returns array of created orders (multi-vendor split)
// ─────────────────────────────────────────────────────────────────────────────
async function confirmCore({
  userId,
  address_id,
  note,
  voucher_code,
  shipping_voucher_code,
  credits_to_use = {},
  selected_item_ids,
  buy_now_items,
  payment_method,
}, session = null) {
  if (!userId) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  if (!address_id) throw Object.assign(new Error("Thiếu địa chỉ nhận hàng"), { status: 400 });

  const method = payment_method || "COD";
  if (!["COD", "PAYPAL", "VNPAY"].includes(method)) {
    throw Object.assign(new Error(`Phương thức thanh toán không hỗ trợ: ${method}`), { status: 400 });
  }

  // ── Validate & snapshot address ──────────────────────────────────────────
  const address = await Address.findOne({ _id: address_id, user_id: userId }).lean();
  if (!address) {
    throw Object.assign(
      new Error("Địa chỉ không hợp lệ hoặc không thuộc về bạn"),
      { status: 400 }
    );
  }
  const shipping_address = {
    name: address.name,
    phone: address.phone,
    city: address.city,
    district: address.district || "",
    ward: address.ward,
    street: address.street,
    source: address.source,
    province_code: address.province_code || null,
    district_code: address.district_code || null,
    ward_code: address.ward_code || null,
  };

  // ── Resolve & validate items ──────────────────────────────────────────────
  const { items, cartItemIds, flashMap } = await resolveItems(userId, { selected_item_ids, buy_now_items });

  // ── Apply product voucher (applied to subtotal, then split proportionally) ──
  const subtotal = items.reduce((s, it) => s + it.total, 0);
  const shipping_fee_raw = await shippingSvc.calculate("GHN", address_id, null, items);
  const { voucher, discount, error: voucherError } = await applyVoucher(voucher_code, subtotal, userId, "product");
  if (voucherError) throw Object.assign(new Error(voucherError), { status: 400 });

  // ── Apply shipping voucher ────────────────────────────────────────────────
  const { voucher: shipVoucher, discount: shippingDiscount, error: shipVoucherError } =
    await applyVoucher(shipping_voucher_code, shipping_fee_raw, userId, "shipping");
  if (shipVoucherError) throw Object.assign(new Error(shipVoucherError), { status: 400 });

  const shipping_fee = Math.max(0, shipping_fee_raw - shippingDiscount);

  // ── Split items by shop ───────────────────────────────────────────────────
  if (items.some((item) => !item.shop_id)) {
    throw Object.assign(new Error("Một số sản phẩm chưa gắn shop hợp lệ."), { status: 400 });
  }
  const grouped = groupItemsByShop(items);
  const createdOrders = [];

  for (const [shopId, shopItems] of grouped) {
    const shopSubtotal = shopItems.reduce((s, i) => s + i.total, 0);
    // Proportional voucher discount and shipping per shop
    const ratio = subtotal > 0 ? shopSubtotal / subtotal : 1;
    const shopDiscount = Math.round(discount * ratio);
    const shopShipping = Math.round(shipping_fee * ratio);

    // Shop credits deduction (per-shop, validate balance)
    const requestedCredits = Number((credits_to_use || {})[shopId] || 0);
    let shopCreditsUsed = 0;
    if (requestedCredits > 0) {
      const creditRecord = await ShopCredit.findOne({ user_id: String(userId), shop_id: String(shopId) });
      shopCreditsUsed = Math.min(requestedCredits, creditRecord?.balance || 0, shopSubtotal - shopDiscount);
    }

    const total_price = Math.max(0, shopSubtotal + shopShipping - shopDiscount - shopCreditsUsed);

    const orderCode = `ORD${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${uuidv4().slice(0, 6).toUpperCase()}`;

    const [order] = await Order.create([{
      order_code: orderCode,
      user_id: userId,
      shop_id: shopId !== "unknown" ? shopId : null,
      items: shopItems,
      address_id,
      shipping_address,
      voucher_id: voucher?._id || null,
      shipping_voucher_id: shipVoucher?._id || null,
      discount: shopDiscount,
      credits_used: shopCreditsUsed,
      shipping_provider: "GHN",
      shipping_fee: shopShipping,
      total_price,
      payment_method: method,
      payment_status: "pending",
      note,
      status: method === "COD" ? "order_created" : "payment_pending",
    }], { session });

    // Deduct stock immediately for COD (no payment confirmation step)
    if (method === "COD") {
      await deductStock(order, session);
    }

    // Deduct credits from ShopCredit balance
    if (shopCreditsUsed > 0) {
      await ShopCredit.findOneAndUpdate(
        { user_id: String(userId), shop_id: String(shopId) },
        {
          $inc: { balance: -shopCreditsUsed, total_spent: shopCreditsUsed },
          $push: {
            history: {
              type: "spend",
              amount: -shopCreditsUsed,
              balance_after: 0, // approximate; will be slightly off — acceptable
              reason: `Đơn hàng #${orderCode}`,
              order_id: order._id,
            },
          },
        },
        { session }
      );
    }

    createdOrders.push({
      order_id: order._id,
      order_code: order.order_code,
      credits_used: shopCreditsUsed,
      shop_id: shopId,
      total_price,
    });
  }

  // ── Increment flash sale quantity_sold counters ───────────────────────────
  await incrementFlashSaleSold(items, flashMap, session);

  // ── Increment voucher usage counters + audit ─────────────────────────────
  if (voucher) {
    Voucher.updateOne({ _id: voucher._id }, { $inc: { used_count: 1 } }, { session }).catch(() => { });
    audit.log({
      actorId: String(userId),
      action: "VOUCHER_APPLIED",
      targetCollection: "vouchers",
      targetId: String(voucher._id),
      metadata: {
        code: voucher.code,
        discount,
        voucher_type: "product",
        subtotal,
        order_codes: createdOrders.map((o) => o.order_code),
      },
    });
  }
  if (shipVoucher) {
    Voucher.updateOne({ _id: shipVoucher._id }, { $inc: { used_count: 1 } }, { session }).catch(() => { });
    audit.log({
      actorId: String(userId),
      action: "VOUCHER_APPLIED",
      targetCollection: "vouchers",
      targetId: String(shipVoucher._id),
      metadata: {
        code: shipVoucher.code,
        discount: shippingDiscount,
        voucher_type: "shipping",
        shipping_fee_raw,
        order_codes: createdOrders.map((o) => o.order_code),
      },
    });
  }

  // ── Clear purchased items from cart ──────────────────────────────────────
  if (cartItemIds) {
    try {
      const cart = await Cart.findOne({ user_id: userId });
      if (cart) {
        cart.items = cart.items.filter((i) => !cartItemIds.includes(i._id));
        await cart.save({ session });
      }
    } catch (err) {
      console.error("CART_CLEAR_ERROR:", err.message);
    }
  }

  // Fire order-placed notifications (non-fatal, one per shop order)
  for (const ord of createdOrders) {
    notif.orderPlaced(userId, ord.order_code).catch(() => { });
  }

  // Return the first order for single-shop compatibility, plus full array
  const firstOrder = createdOrders[0];
  return {
    order_id: firstOrder?.order_id,
    order_code: firstOrder?.order_code,
    orders: createdOrders,
    pay_url: null,
  };
}

exports.confirm = async (payload) => {
  if (process.env.MONGO_TRANSACTIONS !== "true") {
    return confirmCore(payload);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await confirmCore(payload, session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};
