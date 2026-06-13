/**
 * refundService.js
 *
 * Central service for all wallet-crediting refund operations.
 *
 * Refund scenarios covered:
 *  1. Auto-refund when a paid order is cancelled (by customer or shop)
 *  2. Managed refund when a return/exchange is completed by shop
 *  3. Partial refund (amount param on managed refunds)
 *
 * Money flow:
 *   Customer Wallet  â† refund amount (credit, direction: "in")
 *   Shop Wallet      â†’ refund amount (debit,  direction: "out")
 *
 * COD orders are never prepaid, so no wallet credit is issued.
 * PAYPAL / VNPAY / WALLET orders always credit the customer's platform wallet
 * (external gateway refunds are handled separately by paymentController).
 */

const Wallet      = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const Refund      = require("../models/Refund");
const Order       = require("../models/Order");
const finance     = require("./financeLedgerService");

/** Payment methods that require a wallet refund when reversed */
const PREPAID_METHODS = new Set(["PAYPAL", "VNPAY", "WALLET"]);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Internal helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function findOrCreateWallet(userId, type = "customer") {
  let wallet = await Wallet.findOne({ user_id: userId, type });
  if (!wallet) {
    wallet = await Wallet.create({ user_id: userId, type });
  }
  return wallet;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// isRefundable
// Returns true when the order qualifies for a wallet refund.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function isRefundable(order) {
  return (
    PREPAID_METHODS.has((order.payment_method || "").toUpperCase()) &&
    order.payment_status === "paid"
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// creditCustomerWallet
// Adds money to the customer's wallet and records the transaction.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function creditCustomerWallet(userId, amount, orderId, note, meta = {}) {
  if (!amount || Number(amount) <= 0) {
    throw new Error("Refund amount must be positive");
  }

  const wallet = await findOrCreateWallet(userId, "customer");

  const txn = await Transaction.create({
    wallet_id:  wallet._id,
    order_id:   orderId || null,
    type:       "refund",
    direction:  "in",
    amount:     Number(amount),
    currency:   wallet.currency || "VND",
    status:     "success",
    note:       note || "HoÃ n tiá»n vÃ o vÃ­",
    meta:       { ...meta, refund_to: "wallet" },
  });

  wallet.balance_available    += Number(amount);
  wallet.last_transaction_id   = txn._id;
  await wallet.save();

  return txn;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// deductShopWallet
// Removes money from the shop owner's wallet when a refund is issued.
// Non-fatal: if the wallet doesn't exist or has insufficient funds, the
// deduction is capped at the available balance (prevents negative wallet).
// Returns the transaction doc, or null if nothing was deducted.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function deductShopWallet(shopOwnerId, amount, orderId, note, meta = {}) {
  if (!shopOwnerId || !amount || Number(amount) <= 0) return null;

  const wallet = await Wallet.findOne({ user_id: shopOwnerId, type: "shop" });
  if (!wallet) return null; // Shop wallet not yet created â€” skip

  const deductAmount = Math.min(Number(amount), wallet.balance_available);
  if (deductAmount <= 0) return null;

  const txn = await Transaction.create({
    wallet_id:  wallet._id,
    order_id:   orderId || null,
    type:       "refund",
    direction:  "out",
    amount:     deductAmount,
    currency:   wallet.currency || "VND",
    status:     "success",
    note:       note || "Kháº¥u trá»« hoÃ n tiá»n cho khÃ¡ch",
    meta:       { ...meta, requested_amount: Number(amount) },
  });

  wallet.balance_available   -= deductAmount;
  wallet.last_transaction_id  = txn._id;
  await wallet.save();

  return txn;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// processAutoRefund
// Called when a paid order is cancelled (by customer or shop) BEFORE delivery.
// Immediately credits the customer wallet and debits the shop wallet.
//
// @param order        - the full Order document (not lean)
// @param shopOwnerId  - shop owner's user_id (for wallet deduction)
// @returns { customerTxn, shopTxn } | null
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function processAutoRefund(order, shopOwnerId = null) {
  if (!isRefundable(order)) return null;

  const amount = order.total_price;
  const meta = {
    order_code: order.order_code,
    payment_method: order.payment_method,
    trigger: "cancel",
  };

  return finance.refundToCustomerWallet(order, {
    amount,
    shopOwnerId,
    reason: "auto_cancel",
    metadata: meta,
  });
}
// processManagedRefund
// Called when the shop completes a return / exchange / refund request.
// Uses refundDoc.amount (set by customer at request time, defaulting to
// order.total_price) so partial refunds are supported.
//
// @param refundDoc   - the Refund document (mongoose doc or lean)
// @param order       - the Order document (mongoose doc or lean)
// @param shopOwnerId - shop owner's user_id (for wallet deduction)
// @returns { customerTxn, shopTxn }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function processManagedRefund(refundDoc, order, shopOwnerId = null) {
  const amount = Number(refundDoc.amount) || Number(order.total_price);

  const reason = refundDoc.type || "refund";

  const meta = {
    order_code:     order.order_code,
    refund_id:      String(refundDoc._id),
    refund_type:    refundDoc.type,
    payment_method: order.payment_method,
    trigger:        "managed_refund",
  };

  return finance.refundToCustomerWallet(order, {
    amount,
    refundId: refundDoc._id,
    shopOwnerId,
    reason,
    metadata: meta,
  });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// getUserRefunds
// Returns all refund requests filed by a customer, enriched with order info.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getUserRefunds(userId) {
  const refunds = await Refund.find({ user_id: userId })
    .sort({ createdAt: -1 })
    .lean();

  const orderIds = [...new Set(refunds.map((r) => r.order_id))];
  const orders   = await Order.find({ _id: { $in: orderIds } })
    .select("_id order_code total_price payment_method")
    .lean();
  const orderMap = Object.fromEntries(orders.map((o) => [String(o._id), o]));

  return refunds.map((r) => ({ ...r, order: orderMap[String(r.order_id)] || null }));
}

module.exports = {
  isRefundable,
  processAutoRefund,
  processManagedRefund,
  creditCustomerWallet,
  deductShopWallet,
  getUserRefunds,
};


