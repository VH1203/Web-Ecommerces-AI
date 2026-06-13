const FinancialAccount = require("../models/FinancialAccount");
const JournalEntry = require("../models/JournalEntry");
const LedgerEntry = require("../models/LedgerEntry");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const PlatformFee = require("../models/PlatformFee");
const SystemConfig = require("../models/SystemConfig");
const Shop = require("../models/Shop");
const Order = require("../models/Order");

const SYSTEM_OWNER_ID = "system-platform";
const DEFAULT_FEE_RATE = 0.05;

function money(value) {
  return Math.round(Number(value || 0));
}

function requirePositiveAmount(amount) {
  const normalized = money(amount);
  if (!normalized || normalized <= 0) {
    throw Object.assign(new Error("Amount must be positive"), { status: 400 });
  }
  return normalized;
}

async function getFeeRate() {
  const cfg = await SystemConfig.findOne({ category: "platform", key: "fee_rate" }).lean();
  if (cfg && cfg.value !== undefined && cfg.value !== null) {
    const rate = parseFloat(cfg.value);
    if (!Number.isNaN(rate) && rate >= 0 && rate <= 1) return rate;
  }
  return DEFAULT_FEE_RATE;
}

async function updateFeeRate(newRate) {
  const rate = parseFloat(newRate);
  if (Number.isNaN(rate) || rate < 0 || rate > 1) {
    throw Object.assign(new Error("Fee rate must be between 0 and 1"), { status: 400 });
  }

  await SystemConfig.findOneAndUpdate(
    { category: "platform", key: "fee_rate" },
    { value: String(rate), label: "Platform Fee Rate", input_type: "number" },
    { upsert: true, new: true }
  );

  return rate;
}

async function getAccount({ owner_type, owner_id, account_type, currency = "VND", metadata = {} }, session = null) {
  const query = { owner_type, owner_id: String(owner_id), account_type, currency };
  const update = { $setOnInsert: { ...query, metadata } };
  const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
  if (session) opts.session = session;
  return FinancialAccount.findOneAndUpdate(query, update, opts);
}

async function findOrCreateWallet(userId, type, session = null) {
  const query = { user_id: String(userId), type };
  const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
  if (session) opts.session = session;
  return Wallet.findOneAndUpdate(query, { $setOnInsert: query }, opts);
}

async function resolveShopOwnerId(shopId) {
  const shop = await Shop.findById(shopId).select("owner_id").lean();
  return shop?.owner_id || shopId;
}

async function postJournal({
  type,
  idempotency_key,
  entries,
  order_id = null,
  payment_id = null,
  refund_id = null,
  transaction_id = null,
  description = "",
  metadata = {},
  currency = "VND",
}, session = null) {
  const existing = await JournalEntry.findOne({ idempotency_key }).session(session || null);
  if (existing) return existing;

  if (!Array.isArray(entries) || entries.length < 2) {
    throw Object.assign(new Error("Journal entry requires at least two ledger entries"), { status: 400 });
  }

  const totalDebit = entries
    .filter((entry) => entry.direction === "debit")
    .reduce((sum, entry) => sum + money(entry.amount), 0);
  const totalCredit = entries
    .filter((entry) => entry.direction === "credit")
    .reduce((sum, entry) => sum + money(entry.amount), 0);

  if (totalDebit <= 0 || totalDebit !== totalCredit) {
    throw Object.assign(new Error("Ledger journal is not balanced"), { status: 500 });
  }

  const [journal] = await JournalEntry.create([{
    type,
    idempotency_key,
    order_id,
    payment_id,
    refund_id,
    transaction_id,
    currency,
    total_debit: totalDebit,
    total_credit: totalCredit,
    description,
    metadata,
  }], { session });

  for (const entry of entries) {
    const amount = requirePositiveAmount(entry.amount);
    const sign = entry.direction === "debit" ? 1 : -1;
    const account = await FinancialAccount.findByIdAndUpdate(
      entry.account_id,
      { $inc: { balance: sign * amount } },
      { new: true, session }
    );
    if (!account) throw Object.assign(new Error("Financial account not found"), { status: 404 });

    await LedgerEntry.create([{
      journal_id: journal._id,
      account_id: account._id,
      order_id,
      wallet_id: entry.wallet_id || null,
      direction: entry.direction,
      amount,
      currency,
      balance_after: account.balance,
      description: entry.description || description,
      metadata: entry.metadata || {},
    }], { session });
  }

  return journal;
}

async function createWalletTransaction({
  wallet,
  order_id = null,
  type,
  direction,
  amount,
  status = "success",
  note,
  meta = {},
}, session = null) {
  const [txn] = await Transaction.create([{
    wallet_id: wallet._id,
    order_id,
    type,
    direction,
    amount: requirePositiveAmount(amount),
    currency: wallet.currency || "VND",
    status,
    note,
    meta,
  }], { session });

  wallet.last_transaction_id = txn._id;
  await wallet.save({ session });
  return txn;
}

async function recordPaymentCapture(order, { provider, providerTxnId, paymentId = null, metadata = {} } = {}, session = null) {
  const amount = requirePositiveAmount(order.total_price);
  const providerKey = String(provider || order.payment_method || "UNKNOWN").toLowerCase();
  const gatewayAccount = await getAccount({
    owner_type: "gateway",
    owner_id: providerKey,
    account_type: "gateway_clearing",
  }, session);
  const escrowAccount = await getAccount({
    owner_type: "system",
    owner_id: SYSTEM_OWNER_ID,
    account_type: "platform_escrow",
  }, session);

  const journal = await postJournal({
    type: "payment_capture",
    idempotency_key: `payment_capture:${order._id}`,
    order_id: order._id,
    payment_id: paymentId,
    description: `Capture ${providerKey} payment for order ${order.order_code}`,
    metadata: { provider: providerKey, providerTxnId, order_code: order.order_code, ...metadata },
    entries: [
      { account_id: gatewayAccount._id, direction: "debit", amount },
      { account_id: escrowAccount._id, direction: "credit", amount },
    ],
  }, session);

  await Order.updateOne(
    { _id: order._id, financial_status: { $in: [null, "unpaid", "captured"] } },
    { $set: { financial_status: "escrowed" } },
    { session }
  );

  return journal;
}

async function settleOrder(order, session = null) {
  if (!order || !order._id) throw new Error("Invalid order");

  const existing = await PlatformFee.findOne({ order_id: order._id }).session(session || null);
  if (existing) return existing;

  if (order.payment_status !== "paid") {
    throw Object.assign(new Error("Only paid orders can be settled"), { status: 400 });
  }

  if (order.payment_method === "COD") {
    await recordPaymentCapture(order, { provider: "cod", providerTxnId: order.order_code }, session);
  }

  const orderTotal = requirePositiveAmount(order.total_price);
  const feeRate = await getFeeRate();
  const feeAmount = money(orderTotal * feeRate);
  const shopReceive = orderTotal - feeAmount;
  const shopOwnerId = await resolveShopOwnerId(order.shop_id);

  const escrowAccount = await getAccount({
    owner_type: "system",
    owner_id: SYSTEM_OWNER_ID,
    account_type: "platform_escrow",
  }, session);
  const shopPayableAccount = await getAccount({
    owner_type: "shop",
    owner_id: shopOwnerId,
    account_type: "shop_payable",
  }, session);
  const revenueAccount = await getAccount({
    owner_type: "system",
    owner_id: SYSTEM_OWNER_ID,
    account_type: "platform_revenue",
  }, session);

  await postJournal({
    type: "order_settlement",
    idempotency_key: `order_settlement:${order._id}`,
    order_id: order._id,
    description: `Settle order ${order.order_code}`,
    metadata: {
      order_code: order.order_code,
      shop_id: order.shop_id,
      shop_owner_id: shopOwnerId,
      fee_rate: feeRate,
      fee_amount: feeAmount,
      shop_receive: shopReceive,
    },
    entries: [
      { account_id: escrowAccount._id, direction: "debit", amount: orderTotal },
      { account_id: shopPayableAccount._id, direction: "credit", amount: shopReceive },
      { account_id: revenueAccount._id, direction: "credit", amount: feeAmount },
    ],
  }, session);

  const shopWallet = await findOrCreateWallet(shopOwnerId, "shop", session);
  shopWallet.balance_available += shopReceive;
  const shopTxn = await createWalletTransaction({
    wallet: shopWallet,
    order_id: order._id,
    type: "payment",
    direction: "in",
    amount: shopReceive,
    note: `Thanh toán đơn #${order.order_code} sau phí ${(feeRate * 100).toFixed(1)}%`,
    meta: { source: "ledger_settlement", order_code: order.order_code, fee_rate: feeRate, fee_amount: feeAmount },
  }, session);

  const systemWallet = await findOrCreateWallet(SYSTEM_OWNER_ID, "system", session);
  systemWallet.balance_available += feeAmount;
  await createWalletTransaction({
    wallet: systemWallet,
    order_id: order._id,
    type: "payment",
    direction: "in",
    amount: feeAmount,
    note: `Phí nền tảng đơn #${order.order_code}`,
    meta: { source: "ledger_settlement", order_code: order.order_code, shop_id: order.shop_id, fee_rate: feeRate },
  }, session);

  await Order.updateOne(
    { _id: order._id },
    { $set: { financial_status: "settled", settled_at: new Date() } },
    { session }
  );

  return PlatformFee.create([{
    order_id: order._id,
    order_code: order.order_code,
    shop_id: order.shop_id,
    user_id: order.user_id,
    order_total: orderTotal,
    fee_rate: feeRate,
    fee_amount: feeAmount,
    shop_receive: shopReceive,
    note: `shop_txn:${shopTxn._id}`,
  }], { session }).then(([doc]) => doc);
}

async function refundToCustomerWallet(order, {
  amount,
  refundId = null,
  shopOwnerId = null,
  reason = "refund",
  metadata = {},
} = {}, session = null) {
  const refundAmount = requirePositiveAmount(amount || order.total_price);
  const resolvedShopOwnerId = shopOwnerId || await resolveShopOwnerId(order.shop_id);
  const pfee = await PlatformFee.findOne({ order_id: order._id, status: "settled" }).session(session || null);

  const customerAccount = await getAccount({
    owner_type: "customer",
    owner_id: order.user_id,
    account_type: "customer_wallet",
  }, session);
  const sourceAccount = pfee
    ? await getAccount({ owner_type: "shop", owner_id: resolvedShopOwnerId, account_type: "shop_payable" }, session)
    : await getAccount({ owner_type: "system", owner_id: SYSTEM_OWNER_ID, account_type: "platform_escrow" }, session);

  await postJournal({
    type: "refund",
    idempotency_key: `refund:${refundId || order._id}:${refundAmount}`,
    order_id: order._id,
    refund_id: refundId,
    description: `Refund order ${order.order_code} to customer wallet`,
    metadata: {
      order_code: order.order_code,
      reason,
      source: pfee ? "shop_payable" : "platform_escrow",
      shop_owner_id: resolvedShopOwnerId,
      ...metadata,
    },
    entries: [
      { account_id: sourceAccount._id, direction: "debit", amount: refundAmount },
      { account_id: customerAccount._id, direction: "credit", amount: refundAmount },
    ],
  }, session);

  const customerWallet = await findOrCreateWallet(order.user_id, "customer", session);
  customerWallet.balance_available += refundAmount;
  const customerTxn = await createWalletTransaction({
    wallet: customerWallet,
    order_id: order._id,
    type: "refund",
    direction: "in",
    amount: refundAmount,
    note: `Hoàn tiền đơn #${order.order_code}`,
    meta: { source: "ledger_refund", refund_id: refundId, reason, ...metadata },
  }, session);

  let shopTxn = null;
  if (pfee) {
    const shopWallet = await findOrCreateWallet(resolvedShopOwnerId, "shop", session);
    const deductAmount = Math.min(refundAmount, Math.max(0, Number(shopWallet.balance_available || 0)));
    if (deductAmount > 0) {
      shopWallet.balance_available -= deductAmount;
      shopTxn = await createWalletTransaction({
        wallet: shopWallet,
        order_id: order._id,
        type: "refund",
        direction: "out",
        amount: deductAmount,
        note: `Khấu trừ hoàn tiền đơn #${order.order_code}`,
        meta: { source: "ledger_refund", refund_id: refundId, requested_amount: refundAmount },
      }, session);
    }

    if (refundAmount >= Number(order.total_price || 0)) {
      pfee.status = "reversed";
      pfee.note = `${pfee.note || ""} reversed by refund ${refundId || ""}`.trim();
      await pfee.save({ session });
    }
  }

  await Order.updateOne(
    { _id: order._id },
    { $set: { financial_status: refundAmount >= Number(order.total_price || 0) ? "refunded" : "partially_refunded" } },
    { session }
  );

  return { customerTxn, shopTxn };
}

async function settleWalletDeposit({ wallet, transaction, providerTxnId, bankCode }, session = null) {
  const amount = requirePositiveAmount(transaction.amount);
  const gatewayAccount = await getAccount({
    owner_type: "gateway",
    owner_id: "vnpay",
    account_type: "gateway_clearing",
  }, session);
  const customerAccount = await getAccount({
    owner_type: "customer",
    owner_id: wallet.user_id,
    account_type: "customer_wallet",
  }, session);

  await postJournal({
    type: "wallet_deposit",
    idempotency_key: `wallet_deposit:${transaction._id}`,
    transaction_id: transaction._id,
    description: `Wallet deposit ${transaction._id}`,
    metadata: { provider: "vnpay", providerTxnId, bankCode, wallet_id: wallet._id },
    entries: [
      { account_id: gatewayAccount._id, direction: "debit", amount },
      { account_id: customerAccount._id, direction: "credit", amount },
    ],
  }, session);

  wallet.balance_available += amount;
  wallet.last_transaction_id = transaction._id;
  await wallet.save({ session });
}

async function reserveWithdrawal(wallet, transaction, session = null) {
  const amount = requirePositiveAmount(transaction.amount);
  const walletAccount = await getAccount({
    owner_type: wallet.type === "shop" ? "shop" : "customer",
    owner_id: wallet.user_id,
    account_type: wallet.type === "shop" ? "shop_payable" : "customer_wallet",
  }, session);
  const payoutAccount = await getAccount({
    owner_type: "system",
    owner_id: SYSTEM_OWNER_ID,
    account_type: "payout_clearing",
  }, session);

  return postJournal({
    type: "withdraw_reserve",
    idempotency_key: `withdraw_reserve:${transaction._id}`,
    transaction_id: transaction._id,
    description: `Reserve withdrawal ${transaction._id}`,
    metadata: { wallet_id: wallet._id, wallet_type: wallet.type },
    entries: [
      { account_id: walletAccount._id, direction: "debit", amount },
      { account_id: payoutAccount._id, direction: "credit", amount },
    ],
  }, session);
}

async function approveWithdrawal(wallet, transaction, session = null) {
  const amount = requirePositiveAmount(transaction.amount);
  const payoutAccount = await getAccount({
    owner_type: "system",
    owner_id: SYSTEM_OWNER_ID,
    account_type: "payout_clearing",
  }, session);
  const gatewayAccount = await getAccount({
    owner_type: "gateway",
    owner_id: "bank",
    account_type: "gateway_clearing",
  }, session);

  return postJournal({
    type: "withdraw_approve",
    idempotency_key: `withdraw_approve:${transaction._id}`,
    transaction_id: transaction._id,
    description: `Approve withdrawal ${transaction._id}`,
    metadata: { wallet_id: wallet._id, wallet_type: wallet.type },
    entries: [
      { account_id: payoutAccount._id, direction: "debit", amount },
      { account_id: gatewayAccount._id, direction: "credit", amount },
    ],
  }, session);
}

async function rejectWithdrawal(wallet, transaction, session = null) {
  const amount = requirePositiveAmount(transaction.amount);
  const payoutAccount = await getAccount({
    owner_type: "system",
    owner_id: SYSTEM_OWNER_ID,
    account_type: "payout_clearing",
  }, session);
  const walletAccount = await getAccount({
    owner_type: wallet.type === "shop" ? "shop" : "customer",
    owner_id: wallet.user_id,
    account_type: wallet.type === "shop" ? "shop_payable" : "customer_wallet",
  }, session);

  return postJournal({
    type: "withdraw_reject",
    idempotency_key: `withdraw_reject:${transaction._id}`,
    transaction_id: transaction._id,
    description: `Reject withdrawal ${transaction._id}`,
    metadata: { wallet_id: wallet._id, wallet_type: wallet.type },
    entries: [
      { account_id: payoutAccount._id, direction: "debit", amount },
      { account_id: walletAccount._id, direction: "credit", amount },
    ],
  }, session);
}

module.exports = {
  SYSTEM_OWNER_ID,
  DEFAULT_FEE_RATE,
  getFeeRate,
  updateFeeRate,
  getAccount,
  postJournal,
  recordPaymentCapture,
  settleOrder,
  refundToCustomerWallet,
  settleWalletDeposit,
  reserveWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  findOrCreateWallet,
};
