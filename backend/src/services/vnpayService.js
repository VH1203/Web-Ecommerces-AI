// services/vnpayService.js
//
// VNPAY Sandbox payment integration (API v2.1.0).
// Uses manual HMAC-SHA512 hash (raw decoded values) to match VNPay's verification.
// IPN response constants imported from `vnpay` library for convenience.
//
// Two-callback architecture:
//
//   IPN  (vnp_IpnUrl)    â€” VNPAY server â†’ our server, server-to-server.
//                           PRIMARY source of truth for order settlement.
//                           Must respond with JSON { RspCode, Message }.
//                           VNPAY retries until it receives RspCode "00" or "02".
//
//   Return URL           â€” VNPAY redirects user's browser â†’ our server â†’ FE.
//                           SECONDARY / fallback: also settles if IPN hasn't arrived yet.
//                           settleVNPayOrder() is idempotent â€” safe to call from both.

const crypto   = require("crypto");
const { v4: uuidv4 } = require("uuid");
const {
  IpnSuccess,
  IpnFailChecksum,
  IpnInvalidAmount,
  IpnOrderNotFound,
  InpOrderAlreadyConfirmed,
  IpnUnknownError,
  getDateInGMT7,
  dateFormat,
} = require("vnpay");

const vnpayCfg    = require("../config/vnpay");
const notif       = require("./dbNotificationService");
const Order       = require("../models/Order");
const Payment     = require("../models/Payment");
const Wallet      = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const AuditLog    = require("../models/AuditLog");
const inventory   = require("./inventoryService");
const finance     = require("./financeLedgerService");

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Internal helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Normalize library IPN constant { RspCode, Message } to { rspCode, message }
 * so the existing controller interface remains unchanged.
 */
function ipnResponse({ RspCode, Message }, extras = {}) {
  return { rspCode: RspCode, message: Message, ...extras };
}

/**
 * Format a JS Date to VNPAY's required YYYYMMDDHHmmss in UTC+7 (Vietnam).
 * Uses library's getDateInGMT7 + dateFormat for correct timezone handling.
 */
function formatVNDate(date = new Date()) {
  return dateFormat(getDateInGMT7(date));
}

/**
 * Sort object keys alphabetically.
 */
function sortObject(obj) {
  const sorted = {};
  Object.keys(obj).sort().forEach((k) => { sorted[k] = obj[k]; });
  return sorted;
}

/**
 * Compute HMAC-SHA512 on raw (non-URL-encoded) sorted query string.
 * VNPay computes hash on decoded values â€” must match exactly.
 */
function createSecureHash(params, secret) {
  const signData = Object.keys(sortObject(params))
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto
    .createHmac("sha512", secret)
    .update(Buffer.from(signData, "utf-8"))
    .digest("hex");
}

/**
 * Extract and verify vnp_SecureHash from a query-param object.
 * Returns { isValid, params (hash fields stripped) }
 */
function extractAndVerifyHash(rawQuery) {
  const params       = { ...rawQuery };
  const receivedHash = params["vnp_SecureHash"] || "";
  delete params["vnp_SecureHash"];
  delete params["vnp_SecureHashType"];

  if (!receivedHash) {
    return { isValid: false, params };
  }

  const computedHash = createSecureHash(params, vnpayCfg.hashSecret);
  const isValid      = computedHash === receivedHash;

  if (!isValid) {
    console.warn(`[VNPAY] Hash mismatch | expected: ${computedHash.slice(0,20)}... | received: ${receivedHash.slice(0,20)}...`);
  }
  return { isValid, params };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// createVNPayUrl
// Builds a VNPAY payment URL for a pending order.
// Returns: { payUrl, txnRef }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function createVNPayUrl(orderId, ipAddr) {
  const order = await Order.findById(orderId).lean();
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (order.payment_method !== "VNPAY") {
    throw Object.assign(new Error("Order payment method is not VNPAY"), { status: 400 });
  }
  if (order.payment_status === "paid") {
    throw Object.assign(new Error("Order already paid"), { status: 400 });
  }

  const txnRef     = order.order_code;
  const createDate = formatVNDate();
  const expireDate = formatVNDate(new Date(Date.now() + 15 * 60 * 1000)); // +15 min

  const cleanIp = (ipAddr || "127.0.0.1").replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
  const isLocalhostIpn = /localhost|127\.0\.0\.1/.test(vnpayCfg.ipnUrl);

  const params = {
    vnp_Version:    "2.1.0",
    vnp_Command:    "pay",
    vnp_TmnCode:    vnpayCfg.tmnCode,
    vnp_Amount:     String(Math.round(order.total_price) * 100),
    vnp_CurrCode:   "VND",
    vnp_TxnRef:     txnRef,
    vnp_OrderInfo:  `Thanh toan don hang ${order.order_code}`,
    vnp_OrderType:  "other",
    vnp_Locale:     "vn",
    vnp_ReturnUrl:  vnpayCfg.returnUrl,
    vnp_IpAddr:     cleanIp,
    vnp_CreateDate: createDate,
    vnp_ExpireDate: expireDate,
  };

  if (!isLocalhostIpn) {
    params.vnp_IpnUrl = vnpayCfg.ipnUrl;
  }

  // Hash on raw sorted string (VNPay standard)
  const secureHash   = createSecureHash(params, vnpayCfg.hashSecret);
  const sortedParams = sortObject(params);

  // URL-encode values for the query string
  const queryStr = Object.keys(sortedParams)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(sortedParams[k])}`)
    .join("&");
  const payUrl = `${vnpayCfg.url}?${queryStr}&vnp_SecureHash=${secureHash}`;

  await Payment.findOneAndUpdate(
    { order_id: order._id, gateway: "VNPAY" },
    {
      order_id:        order._id,
      user_id:         order.user_id,
      shop_id:         order.shop_id,
      gateway:         "VNPAY",
      method:          "vnpay",
      amount:          order.total_price,
      currency:        "VND",
      status:          "pending",
      vnpay_txn_ref:   txnRef,
      idempotency_key: uuidv4(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`[VNPAY] URL created | order: ${order.order_code} | ip: ${cleanIp} | createDate: ${createDate} | expireDate: ${expireDate}`);
  return { payUrl, txnRef };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// verifyIpn
// Returns: { rspCode, message, orderCode, transactionNo, bankCode, isSuccess }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function verifyIpn(query) {
  const { isValid, params } = extractAndVerifyHash(query);

  if (!isValid) {
    return ipnResponse(IpnFailChecksum);
  }

  const orderCode     = params["vnp_TxnRef"]        || "";
  const transactionNo = params["vnp_TransactionNo"]  || "";
  const bankCode      = params["vnp_BankCode"]        || "";
  const vnpAmount     = Number(params["vnp_Amount"])  || 0;
  const isSuccess     = params["vnp_ResponseCode"] === "00";

  const order = await Order.findOne({ order_code: orderCode }).lean();
  if (!order) {
    console.warn(`[VNPAY IPN] Order not found: ${orderCode}`);
    return ipnResponse(IpnOrderNotFound);
  }

  if (order.payment_status === "paid") {
    console.log(`[VNPAY IPN] Already confirmed: ${orderCode}`);
    return ipnResponse(InpOrderAlreadyConfirmed, { orderCode, transactionNo, bankCode, isSuccess: true });
  }

  const expectedVnpAmount = Math.round(order.total_price) * 100;
  if (vnpAmount !== expectedVnpAmount) {
    console.error(`[VNPAY IPN] Amount mismatch | expected: ${expectedVnpAmount} | received: ${vnpAmount}`);
    return ipnResponse(IpnInvalidAmount);
  }

  console.log(`[VNPAY IPN] Verified | order: ${orderCode} | success: ${isSuccess} | bank: ${bankCode}`);
  return ipnResponse(IpnSuccess, { orderCode, transactionNo, bankCode, isSuccess });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// verifyReturnUrl
// Returns: { isValid, isSuccess, orderCode, transactionNo, bankCode, responseCode }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function verifyReturnUrl(query) {
  const { isValid, params } = extractAndVerifyHash(query);

  const responseCode  = params["vnp_ResponseCode"] || "";
  const isSuccess     = responseCode === "00";
  const orderCode     = params["vnp_TxnRef"]        || "";
  const transactionNo = params["vnp_TransactionNo"]  || "";
  const bankCode      = params["vnp_BankCode"]        || "";

  console.log(`[VNPAY Return] hash: ${isValid} | success: ${isSuccess} | orderCode: ${orderCode}`);
  return { isValid, isSuccess, orderCode, transactionNo, bankCode, responseCode };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// settleVNPayOrder â€” IDEMPOTENT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function settleVNPayOrder(orderCode, transactionNo, bankCode) {
  const order = await Order.findOne({ order_code: orderCode });
  if (!order) throw Object.assign(new Error(`Order not found: ${orderCode}`), { status: 404 });

  if (order.payment_status === "paid") {
    console.log(`[VNPAY] Already settled: ${orderCode} â€” skipping`);
    return order;
  }

  order.payment_status = "paid";
  order.status         = "processing";
  if (!order.status_history) order.status_history = [];
  order.status_history.push({ status: "processing", at: new Date(), by: "system", note: `VNPAY payment confirmed â€” txn: ${transactionNo}` });
  await inventory.deductOrderStock(order);
  await order.save();

  await Payment.findOneAndUpdate(
    { order_id: order._id, gateway: "VNPAY" },
    {
      $set: {
        status:               "success",
        vnpay_transaction_no: transactionNo,
        vnpay_bank_code:      bankCode,
        provider_txn_id:      transactionNo,
        paid_at:              new Date(),
        webhook_verified:     true,
      },
    }
  );

  const payment = await Payment.findOne({ order_id: order._id, gateway: "VNPAY" }).lean();
  await finance.recordPaymentCapture(order, {
    provider: "vnpay",
    providerTxnId: transactionNo,
    paymentId: payment?._id || null,
    metadata: { bankCode },
  });

  await AuditLog.create({
    action:            "VNPAY_PAYMENT_SUCCESS",
    target_collection: "orders",
    target_id:         order._id,
    metadata:          { orderCode, transactionNo, bankCode, amount: order.total_price },
  });

  notif.paymentSuccess(order.user_id, orderCode, order.total_price).catch(() => {});
  console.log(`[VNPAY] Settled: ${orderCode} | txn: ${transactionNo} | bank: ${bankCode}`);
  return order;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// failVNPayOrder â€” IDEMPOTENT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function failVNPayOrder(orderCode, responseCode) {
  const order = await Order.findOne({ order_code: orderCode });
  if (!order) { console.warn(`[VNPAY] failVNPayOrder: not found ${orderCode}`); return; }
  if (order.payment_status !== "pending") return;

  order.payment_status = "failed";
  await order.save();

  await Payment.findOneAndUpdate(
    { order_id: order._id, gateway: "VNPAY" },
    { $set: { status: "failed" } }
  );

  await AuditLog.create({
    action:            "VNPAY_PAYMENT_FAILED",
    target_collection: "orders",
    target_id:         order._id,
    metadata:          { orderCode, responseCode },
  });

  notif.paymentFailed(order.user_id, orderCode).catch(() => {});
  console.log(`[VNPAY] Failed: ${orderCode} | responseCode: ${responseCode}`);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// createWalletDepositUrl
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function createWalletDepositUrl(walletId, txnRef, amount, ipAddr) {
  const createDate = formatVNDate();
  const expireDate = formatVNDate(new Date(Date.now() + 15 * 60 * 1000));

  const depReturnUrl =
    process.env.VNPAY_DEPOSIT_RETURN_URL ||
    vnpayCfg.returnUrl.replace("/payment/vnpay/return", "/wallets/deposit/vnpay/return");

  const cleanIp = (ipAddr || "127.0.0.1").replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
  const isLocalhostIpn = /localhost|127\.0\.0\.1/.test(vnpayCfg.ipnUrl);

  const params = {
    vnp_Version:    "2.1.0",
    vnp_Command:    "pay",
    vnp_TmnCode:    vnpayCfg.tmnCode,
    vnp_Amount:     String(Math.round(amount) * 100),
    vnp_CurrCode:   "VND",
    vnp_TxnRef:     txnRef,
    vnp_OrderInfo:  `Nap vi ${txnRef}`,
    vnp_OrderType:  "other",
    vnp_Locale:     "vn",
    vnp_ReturnUrl:  depReturnUrl,
    vnp_IpAddr:     cleanIp,
    vnp_CreateDate: createDate,
    vnp_ExpireDate: expireDate,
  };

  if (!isLocalhostIpn) {
    params.vnp_IpnUrl = vnpayCfg.ipnUrl;
  }

  const secureHash   = createSecureHash(params, vnpayCfg.hashSecret);
  const sortedParams = sortObject(params);
  const queryStr = Object.keys(sortedParams)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(sortedParams[k])}`)
    .join("&");
  const payUrl = `${vnpayCfg.url}?${queryStr}&vnp_SecureHash=${secureHash}`;

  console.log(`[VNPAY DEP] URL created | wallet: ${walletId} | txnRef: ${txnRef} | amount: ${amount}`);
  return { payUrl };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// verifyDepositIpn
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function verifyDepositIpn(query) {
  const { isValid, params } = extractAndVerifyHash(query);

  if (!isValid) return ipnResponse(IpnFailChecksum);

  const txnRef        = params["vnp_TxnRef"]        || "";
  const transactionNo = params["vnp_TransactionNo"]  || "";
  const bankCode      = params["vnp_BankCode"]        || "";
  const vnpAmount     = Number(params["vnp_Amount"])  || 0;
  const isSuccess     = params["vnp_ResponseCode"] === "00";

  const txn = await Transaction.findOne({ "meta.vnp_txn_ref": txnRef, type: "deposit" }).lean();
  if (!txn) {
    console.warn(`[VNPAY DEP IPN] Deposit not found: ${txnRef}`);
    return ipnResponse(IpnOrderNotFound, { message: "Deposit not found" });
  }

  if (txn.status === "success") {
    return ipnResponse(InpOrderAlreadyConfirmed, { txnRef, transactionNo, bankCode, isSuccess: true });
  }

  const expectedAmount = Math.round(txn.amount) * 100;
  if (vnpAmount !== expectedAmount) {
    console.error(`[VNPAY DEP IPN] Amount mismatch | expected: ${expectedAmount} | received: ${vnpAmount}`);
    return ipnResponse(IpnInvalidAmount);
  }

  console.log(`[VNPAY DEP IPN] Verified | txnRef: ${txnRef} | success: ${isSuccess}`);
  return ipnResponse(IpnSuccess, { txnRef, transactionNo, bankCode, isSuccess });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// settleWalletDeposit â€” IDEMPOTENT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function settleWalletDeposit(txnRef, transactionNo, bankCode) {
  const txn = await Transaction.findOne({ "meta.vnp_txn_ref": txnRef, type: "deposit" });
  if (!txn) { console.warn(`[VNPAY DEP] settleWalletDeposit: not found ${txnRef}`); return null; }
  if (txn.status === "success") { console.log(`[VNPAY DEP] Already settled: ${txnRef}`); return txn; }

  const wallet = await Wallet.findById(txn.wallet_id);
  if (!wallet) throw Object.assign(new Error(`Wallet not found: ${txn.wallet_id}`), { status: 404 });

  await finance.settleWalletDeposit({ wallet, transaction: txn, providerTxnId: transactionNo, bankCode });

  txn.status = "success";
  txn.meta   = { ...txn.meta, transactionNo, bankCode, settled_at: new Date().toISOString() };
  await txn.save();

  await AuditLog.create({
    action:            "WALLET_DEPOSIT_SUCCESS",
    target_collection: "transactions",
    target_id:         txn._id,
    metadata:          { txnRef, transactionNo, bankCode, amount: txn.amount, walletId: wallet._id },
  });

  notif.paymentSuccess(wallet.user_id, txnRef, txn.amount).catch(() => {});
  console.log(`[VNPAY DEP] Settled: ${txnRef} | txn: ${transactionNo} | amount: ${txn.amount}`);
  return txn;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// failWalletDeposit â€” IDEMPOTENT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function failWalletDeposit(txnRef, responseCode) {
  const txn = await Transaction.findOne({ "meta.vnp_txn_ref": txnRef, type: "deposit" });
  if (!txn || txn.status !== "pending") return;
  txn.status = "failed";
  await txn.save();
  console.log(`[VNPAY DEP] Failed: ${txnRef} | responseCode: ${responseCode}`);
}

module.exports = {
  createVNPayUrl,
  verifyIpn,
  verifyReturnUrl,
  settleVNPayOrder,
  failVNPayOrder,
  createWalletDepositUrl,
  verifyDepositIpn,
  settleWalletDeposit,
  failWalletDeposit,
};
