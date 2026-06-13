const Order = require("../models/Order");
const ProductVariant = require("../models/ProductVariant");

async function deductOrderStock(order, options = {}) {
  const { session } = options;
  if (!order || order.inventory_adjusted) return;

  const qtyByVariant = new Map();
  for (const item of order.items || []) {
    if (!item.variant_id) continue;
    const key = String(item.variant_id);
    qtyByVariant.set(key, (qtyByVariant.get(key) || 0) + Number(item.qty || 0));
  }

  const bulkOps = [...qtyByVariant.entries()]
    .filter(([, qty]) => qty > 0)
    .map(([variantId, qty]) => ({
      updateOne: {
        filter: { _id: variantId, stock: { $gte: qty } },
        update: { $inc: { stock: -qty } },
      },
    }));

  if (bulkOps.length) {
    const result = await ProductVariant.bulkWrite(bulkOps, { ordered: true, session });
    if (result.modifiedCount !== bulkOps.length) {
      throw Object.assign(new Error("Một số sản phẩm không còn đủ tồn kho. Vui lòng kiểm tra lại giỏ hàng."), { status: 409 });
    }
  }

  order.inventory_adjusted = true;
  if (typeof order.save === "function") {
    await order.save({ session });
  } else {
    await Order.updateOne({ _id: order._id }, { $set: { inventory_adjusted: true } }, { session });
  }
}

module.exports = {
  deductOrderStock,
};
