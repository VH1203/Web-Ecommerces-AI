const checkoutNodeJssdk = require("@paypal/checkout-server-sdk");
const { client } = require("../config/paypal");
const { v4: uuidv4 } = require("uuid");

const Order = require("../models/Order");
const Payment = require("../models/Payment");
const Refund = require("../models/Refund");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const AuditLog = require("../models/AuditLog");
const Shop = require("../models/Shop");
const inventory = require("./inventoryService");
const finance = require("./financeLedgerService");

// â”€â”€ VND â†’ USD conversion (sandbox approximation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Replace VND_TO_USD_RATE with a live rate service in production.
const VND_TO_USD_RATE = Number(process.env.VND_TO_USD_RATE) || 25000;

function toUSD(vndAmount) {
  const usd = Number(vndAmount) / VND_TO_USD_RATE;
  return usd.toFixed(2); // PayPal requires string with 2 decimal places
}

// â”€â”€ createPayPalOrder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Creates a PayPal order from a pending DB order.
// Returns: paypalOrderId (string)
async function createPayPalOrder(orderId) {
  const order = await Order.findById(orderId).lean();
  if (!order) {
    throw Object.assign(new Error("Order not found"), { status: 404 });
  }
  if (order.payment_status === "paid") {
    throw Object.assign(new Error("Order already paid"), { status: 400 });
  }
  if (order.payment_status !== "pending") {
    throw Object.assign(
      new Error("Only pending orders can be paid"),
      { status: 400 }
    );
  }

  const amountUSD = toUSD(order.total_price);

  const request = new checkoutNodeJssdk.orders.OrdersCreateRequest();
  request.prefer("return=representation");
  request.requestBody({
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: order._id,
        description: `DFS Order ${order.order_code}`,
        amount: {
          currency_code: "USD",
          value: amountUSD,
        },
      },
    ],
  });

  const response = await client().execute(request);
  return response.result.id; // PayPal order ID
}

// â”€â”€ capturePayPalOrder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Captures an approved PayPal order and settles the DB order.
// Returns: { order, payment, captureId }
async function capturePayPalOrder(paypalOrderId, orderId) {
  // Guard: prevent double capture
  const existing = await Payment.findOne({
    paypal_order_id: paypalOrderId,
    status: "success",
  }).lean();
  if (existing) {
    throw Object.assign(new Error("Payment already captured"), { status: 400 });
  }

  const order = await Order.findById(orderId);
  if (!order) {
    throw Object.assign(new Error("Order not found"), { status: 404 });
  }
  if (order.payment_status === "paid") {
    throw Object.assign(new Error("Order already paid"), { status: 400 });
  }

  // Execute PayPal capture
  const captureRequest = new checkoutNodeJssdk.orders.OrdersCaptureRequest(paypalOrderId);
  captureRequest.requestBody({});

  let captureResponse;
  try {
    captureResponse = await client().execute(captureRequest);
  } catch (err) {
    // Record failed attempt
    await Payment.create({
      order_id: order._id,
      user_id: order.user_id,
      shop_id: order.shop_id,
      gateway: "PAYPAL",
      method: "paypal",
      amount: order.total_price,
      currency: "VND",
      status: "failed",
      paypal_order_id: paypalOrderId,
      idempotency_key: uuidv4(),
    });
    await AuditLog.create({
      action: "PAYPAL_PAYMENT_FAILED",
      target_collection: "orders",
      target_id: order._id,
      metadata: { paypalOrderId, error: err.message },
    });
    throw Object.assign(
      new Error(`PayPal capture failed: ${err.message}`),
      { status: 502 }
    );
  }

  const captureResult = captureResponse.result;
  if (captureResult.status !== "COMPLETED") {
    throw Object.assign(
      new Error(`PayPal capture status: ${captureResult.status}`),
      { status: 502 }
    );
  }

  const captureId =
    captureResult.purchase_units?.[0]?.payments?.captures?.[0]?.id;

  // Settle DB order
  order.payment_status = "paid";
  order.status = "confirmed";
  await inventory.deductOrderStock(order);
  await order.save();

  // Create successful payment record
  const payment = await Payment.create({
    order_id: order._id,
    user_id: order.user_id,
    shop_id: order.shop_id,
    gateway: "PAYPAL",
    method: "paypal",
    amount: order.total_price,
    currency: "VND",
    status: "success",
    paypal_order_id: paypalOrderId,
    paypal_capture_id: captureId,
    provider_txn_id: captureId,
    idempotency_key: uuidv4(),
    webhook_verified: true,
    paid_at: new Date(),
  });

  await finance.recordPaymentCapture(order, {
    provider: "paypal",
    providerTxnId: captureId,
    paymentId: payment._id,
    metadata: { paypalOrderId },
  });

  // Audit log
  await AuditLog.create({
    action: "PAYPAL_PAYMENT_SUCCESS",
    target_collection: "orders",
    target_id: order._id,
    metadata: { paypalOrderId, captureId, amount: order.total_price },
  });

  return { order, payment, captureId };
}

// â”€â”€ refundPayPal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Refunds a captured PayPal payment.
// Returns: { refund, refundId }
async function refundPayPal(orderId) {
  const order = await Order.findById(orderId).lean();
  if (!order) {
    throw Object.assign(new Error("Order not found"), { status: 404 });
  }
  if (order.payment_status !== "paid") {
    throw Object.assign(new Error("Order has not been paid"), { status: 400 });
  }

  // Find the capture record
  const payment = await Payment.findOne({
    order_id: orderId,
    status: "success",
    paypal_capture_id: { $exists: true, $ne: null },
  }).lean();

  if (!payment?.paypal_capture_id) {
    throw Object.assign(
      new Error("No PayPal capture found for this order"),
      { status: 400 }
    );
  }

  const refundAmountUSD = toUSD(order.total_price);

  const refundRequest = new checkoutNodeJssdk.payments.CapturesRefundRequest(
    payment.paypal_capture_id
  );
  refundRequest.requestBody({
    amount: { value: refundAmountUSD, currency_code: "USD" },
  });

  let refundResponse;
  try {
    refundResponse = await client().execute(refundRequest);
  } catch (err) {
    await AuditLog.create({
      action: "PAYPAL_REFUND_FAILED",
      target_collection: "orders",
      target_id: orderId,
      metadata: { error: err.message },
    });
    throw Object.assign(
      new Error(`PayPal refund failed: ${err.message}`),
      { status: 502 }
    );
  }

  const refundId = refundResponse.result.id;

  // Update payment record
  await Payment.updateOne(
    { _id: payment._id },
    { $set: { status: "refunded" } }
  );

  // Settle order
  await Order.findByIdAndUpdate(orderId, {
    payment_status: "refunded",
    status: "refund_completed",
  });

  // Create refund record
  const refund = await Refund.create({
    order_id: orderId,
    user_id: order.user_id,
    reason: "PayPal refund",
    amount: order.total_price,
    status: "completed",
    processed_at: new Date(),
  });

  // Deduct shop wallet (non-fatal)
  try {
    const shop = await Shop.findById(order.shop_id).select("owner_id").lean();
    const shopWallet = await Wallet.findOne({
      user_id: shop?.owner_id || order.shop_id,
      type: "shop",
    });
    if (shopWallet && shopWallet.balance_available >= order.total_price) {
      shopWallet.balance_available -= order.total_price;
      await shopWallet.save();
      await Transaction.create({
        wallet_id: shopWallet._id,
        order_id: orderId,
        type: "refund",
        direction: "out",
        amount: order.total_price,
        currency: "VND",
        status: "success",
        note: `PayPal refund â€” order ${order.order_code}`,
        meta: { refundId },
      });
    }
  } catch (walletErr) {
    console.error("WALLET_DEDUCT_ERROR:", walletErr.message);
  }

  // Audit log
  await AuditLog.create({
    action: "PAYPAL_REFUND_SUCCESS",
    target_collection: "orders",
    target_id: orderId,
    metadata: { refundId, amount: order.total_price },
  });

  return { refund, refundId };
}

module.exports = { createPayPalOrder, capturePayPalOrder, refundPayPal };
