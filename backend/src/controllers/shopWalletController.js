const Wallet      = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const auditLog    = require("../services/auditLogService");
const finance     = require("../services/financeLedgerService");

// GET /api/shop/wallet
exports.getWallet = async (req, res, next) => {
  try {
    let wallet = await Wallet.findOne({ user_id: req.userId, type: "shop" }).lean();
    if (!wallet) {
      const created = await Wallet.create({ user_id: req.userId, type: "shop" });
      wallet = created.toObject();
    }
    res.json({ success: true, data: { wallet } });
  } catch (e) { next(e); }
};

// GET /api/shop/wallet/transactions
exports.getTransactions = async (req, res, next) => {
  try {
    const wallet = await Wallet.findOne({ user_id: req.userId, type: "shop" }).lean();
    if (!wallet) return res.json({ success: true, data: { transactions: [], total: 0 } });

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      Transaction.find({ wallet_id: wallet._id }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments({ wallet_id: wallet._id }),
    ]);

    res.json({ success: true, data: { transactions, total, page, limit } });
  } catch (e) { next(e); }
};

// POST /api/shop/wallet/withdraw
exports.requestWithdraw = async (req, res, next) => {
  try {
    const { amount, bank_account_id, note } = req.body || {};
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ message: "Số tiền rút không hợp lệ" });
    }

    const wallet = await Wallet.findOne({ user_id: req.userId, type: "shop" });
    if (!wallet) return res.status(404).json({ message: "Không tìm thấy ví cửa hàng" });
    if (wallet.balance_available < Number(amount)) {
      return res.status(400).json({ message: "Số dư không đủ để rút" });
    }

    wallet.balance_available -= Number(amount);
    wallet.balance_pending += Number(amount);

    const txn = await Transaction.create({
      wallet_id: wallet._id,
      type: "withdraw",
      direction: "out",
      amount: Number(amount),
      currency: "VND",
      status: "pending",
      note: note || "Rút tiền về tài khoản ngân hàng",
      meta: { bank_account_id: bank_account_id || null },
    });

    await finance.reserveWithdrawal(wallet, txn);
    wallet.last_transaction_id = txn._id;
    await wallet.save();

    auditLog.log({ actorId: req.userId, action: "wallet.withdraw", targetCollection: "transactions", targetId: txn._id, ip: auditLog.getIp(req), userAgent: auditLog.getUA(req), metadata: { amount: Number(amount), bank_account_id: bank_account_id || null, balance_after: wallet.balance_available } });
    res.json({
      success: true,
      data: { transaction: txn, balance_available: wallet.balance_available },
    });
  } catch (e) { next(e); }
};
