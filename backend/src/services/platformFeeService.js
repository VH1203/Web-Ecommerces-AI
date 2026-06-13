/**
 * platformFeeService.js
 *
 * Handles order settlement: when an order reaches "delivered", this service:
 *  1. Calculates the platform commission fee
 *  2. Credits the shop wallet (order total âˆ’ fee)
 *  3. Credits the system wallet (fee)
 *  4. Records a PlatformFee document
 *
 * Also handles admin operations: approve/reject withdrawals, manual deposits.
 */

const Wallet      = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const PlatformFee = require("../models/PlatformFee");
const SystemConfig = require("../models/SystemConfig");
const Shop        = require("../models/Shop");
const finance     = require("./financeLedgerService");
const FinancialAccount = require("../models/FinancialAccount");

const DEFAULT_FEE_RATE = 0.05; // 5%

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function getFeeRate() {
  return finance.getFeeRate();
}

async function findOrCreateWallet(userId, type) {
  let wallet = await Wallet.findOne({ user_id: userId, type });
  if (!wallet) wallet = await Wallet.create({ user_id: userId, type });
  return wallet;
}

/** The system wallet is owned by a virtual "system" user */
const SYSTEM_USER_ID = "system-platform";

async function getSystemWallet() {
  return findOrCreateWallet(SYSTEM_USER_ID, "system");
}

// â”€â”€â”€ Settlement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * settleOrder â€” called when order status becomes "delivered".
 * Idempotent: skips if a PlatformFee record already exists for this order.
 */
async function settleOrder(order) {
  return finance.settleOrder(order);
}

async function listPendingWithdrawals() {
  const txns = await Transaction.find({ type: "withdraw", status: "pending" })
    .sort({ createdAt: -1 })
    .lean();

  // Enrich with wallet â†’ shop info
  const walletIds = [...new Set(txns.map(t => t.wallet_id))];
  const wallets   = await Wallet.find({ _id: { $in: walletIds } }).lean();
  const walletMap = Object.fromEntries(wallets.map(w => [w._id, w]));

  const shopOwnerIds = wallets.filter(w => w.type === "shop").map(w => w.user_id);
  const shops = await Shop.find({ owner_id: { $in: shopOwnerIds } }).lean();
  const shopByOwner = Object.fromEntries(shops.map(s => [s.owner_id, s]));

  return txns.map(t => {
    const w = walletMap[t.wallet_id] || {};
    const shop = shopByOwner[w.user_id] || {};
    return {
      ...t,
      wallet_type: w.type,
      shop_name:   shop.shop_name || null,
      shop_id:     shop._id || null,
      owner_id:    w.user_id,
    };
  });
}

/**
 * approveWithdrawal â€” marks withdrawal as success, finalizes balance deduction
 */
async function approveWithdrawal(txnId, adminNote) {
  const txn = await Transaction.findById(txnId);
  if (!txn) throw Object.assign(new Error("Transaction not found"), { status: 404 });
  if (txn.type !== "withdraw" || txn.status !== "pending") {
    throw Object.assign(new Error("Transaction is not a pending withdrawal"), { status: 400 });
  }

  const wallet = await Wallet.findById(txn.wallet_id);
  if (!wallet) throw Object.assign(new Error("Wallet not found"), { status: 404 });

  // Move from pending to deducted
  wallet.balance_pending = Math.max(0, wallet.balance_pending - txn.amount);
  wallet.last_transaction_id = txn._id;
  await finance.approveWithdrawal(wallet, txn);
  await wallet.save();

  txn.status = "success";
  txn.note   = (txn.note || "") + (adminNote ? ` | Admin: ${adminNote}` : "");
  txn.meta   = { ...(txn.meta || {}), approved_at: new Date() };
  await txn.save();

  return txn;
}

/**
 * rejectWithdrawal â€” cancels withdrawal, returns balance from pending to available
 */
async function rejectWithdrawal(txnId, reason) {
  const txn = await Transaction.findById(txnId);
  if (!txn) throw Object.assign(new Error("Transaction not found"), { status: 404 });
  if (txn.type !== "withdraw" || txn.status !== "pending") {
    throw Object.assign(new Error("Transaction is not a pending withdrawal"), { status: 400 });
  }

  const wallet = await Wallet.findById(txn.wallet_id);
  if (!wallet) throw Object.assign(new Error("Wallet not found"), { status: 404 });

  wallet.balance_pending   = Math.max(0, wallet.balance_pending - txn.amount);
  wallet.balance_available += txn.amount;
  wallet.last_transaction_id = txn._id;
  await finance.rejectWithdrawal(wallet, txn);
  await wallet.save();

  txn.status = "cancelled";
  txn.note   = (txn.note || "") + ` | Tá»« chá»‘i: ${reason || "KhÃ´ng cÃ³ lÃ½ do"}`;
  txn.meta   = { ...(txn.meta || {}), rejected_at: new Date(), reject_reason: reason };
  await txn.save();

  return txn;
}

// â”€â”€â”€ Admin: Manual deposit to shop wallet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function adminDeposit(shopOwnerId, amount, note) {
  if (!amount || Number(amount) <= 0) {
    throw Object.assign(new Error("Amount must be positive"), { status: 400 });
  }

  const wallet = await findOrCreateWallet(shopOwnerId, "shop");

  const txn = await Transaction.create({
    wallet_id:  wallet._id,
    type:       "deposit",
    direction:  "in",
    amount:     Number(amount),
    currency:   "VND",
    status:     "success",
    note:       note || "Náº¡p tiá»n bá»Ÿi admin",
    meta:       { source: "admin_deposit" },
  });

  wallet.balance_available  += Number(amount);
  wallet.last_transaction_id = txn._id;
  await wallet.save();

  return txn;
}

// â”€â”€â”€ Admin: Dashboard stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function getFinanceStats() {
  const sysWallet = await Wallet.findOne({ user_id: SYSTEM_USER_ID, type: "system" }).lean();

  // Total platform fees
  const feeAgg = await PlatformFee.aggregate([
    { $match: { status: "settled" } },
    { $group: { _id: null, total: { $sum: "$fee_amount" }, count: { $sum: 1 } } },
  ]);

  // Pending withdrawals
  const pendingWithdrawAgg = await Transaction.aggregate([
    { $match: { type: "withdraw", status: "pending" } },
    { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);

  // Completed withdrawals
  const completedWithdrawAgg = await Transaction.aggregate([
    { $match: { type: "withdraw", status: "success" } },
    { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);

  // Total shop balances
  const shopBalanceAgg = await Wallet.aggregate([
    { $match: { type: "shop" } },
    { $group: { _id: null, total_available: { $sum: "$balance_available" }, total_pending: { $sum: "$balance_pending" }, count: { $sum: 1 } } },
  ]);

  // Monthly fee revenue (last 12 months)
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const monthlyFees = await PlatformFee.aggregate([
    { $match: { status: "settled", settled_at: { $gte: twelveMonthsAgo } } },
    {
      $group: {
        _id: { year: { $year: "$settled_at" }, month: { $month: "$settled_at" } },
        fee_total:   { $sum: "$fee_amount" },
        order_total: { $sum: "$order_total" },
        count:       { $sum: 1 },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ]);

  return {
    system_balance:      sysWallet?.balance_available || 0,
    total_fees_collected: feeAgg[0]?.total || 0,
    total_orders_settled: feeAgg[0]?.count || 0,
    pending_withdrawals:  pendingWithdrawAgg[0]?.total || 0,
    pending_withdraw_count: pendingWithdrawAgg[0]?.count || 0,
    completed_withdrawals: completedWithdrawAgg[0]?.total || 0,
    completed_withdraw_count: completedWithdrawAgg[0]?.count || 0,
    shop_total_available: shopBalanceAgg[0]?.total_available || 0,
    shop_total_pending:   shopBalanceAgg[0]?.total_pending || 0,
    shop_count:           shopBalanceAgg[0]?.count || 0,
    monthly_fees:         monthlyFees,
    current_fee_rate:     await getFeeRate(),
    ledger_accounts:      await FinancialAccount.aggregate([
      { $match: { is_active: true } },
      {
        $group: {
          _id: "$account_type",
          balance: { $sum: "$balance" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  };
}

/**
 * getRecentTransactions â€” all wallet transactions for admin view
 */
async function getRecentTransactions({ page = 1, limit = 20, type, status, wallet_type }) {
  const filter = {};
  if (type)   filter.type   = type;
  if (status) filter.status = status;

  // If wallet_type filter, first find wallet IDs
  if (wallet_type) {
    const walletIds = (await Wallet.find({ type: wallet_type }).select("_id").lean()).map(w => w._id);
    filter.wallet_id = { $in: walletIds };
  }

  const skip = (Math.max(1, page) - 1) * limit;

  const [txns, total] = await Promise.all([
    Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.min(limit, 50)).lean(),
    Transaction.countDocuments(filter),
  ]);

  // Enrich with wallet info
  const walletIds = [...new Set(txns.map(t => t.wallet_id))];
  const wallets   = await Wallet.find({ _id: { $in: walletIds } }).lean();
  const walletMap = Object.fromEntries(wallets.map(w => [w._id, w]));

  const ownerIds = wallets.map(w => w.user_id);
  const shops    = await Shop.find({ owner_id: { $in: ownerIds } }).select("_id shop_name owner_id").lean();
  const shopByOwner = Object.fromEntries(shops.map(s => [s.owner_id, s]));

  const enriched = txns.map(t => {
    const w = walletMap[t.wallet_id] || {};
    const shop = shopByOwner[w.user_id];
    return {
      ...t,
      wallet_type: w.type || "unknown",
      wallet_user_id: w.user_id,
      shop_name: shop?.shop_name || null,
    };
  });

  return { transactions: enriched, total, page, limit };
}

/**
 * getPlatformFees â€” list platform fee records with filters
 */
async function getPlatformFees({ page = 1, limit = 20, shop_id }) {
  const filter = {};
  if (shop_id) filter.shop_id = shop_id;

  const skip = (Math.max(1, page) - 1) * limit;

  const [fees, total] = await Promise.all([
    PlatformFee.find(filter).sort({ settled_at: -1 }).skip(skip).limit(Math.min(limit, 50)).lean(),
    PlatformFee.countDocuments(filter),
  ]);

  return { fees, total, page, limit };
}

/**
 * updateFeeRate â€” update platform fee rate in system config
 */
async function updateFeeRate(newRate) {
  return finance.updateFeeRate(newRate);
}

module.exports = {
  settleOrder,
  getFeeRate,
  updateFeeRate,
  listPendingWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  adminDeposit,
  getFinanceStats,
  getRecentTransactions,
  getPlatformFees,
  getSystemWallet,
  SYSTEM_USER_ID,
};


