const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const LedgerEntrySchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => `led-${uuidv4()}` },
    journal_id: { type: String, ref: "JournalEntry", required: true },
    account_id: { type: String, ref: "FinancialAccount", required: true },
    order_id: { type: String, ref: "Order" },
    wallet_id: { type: String, ref: "Wallet" },
    direction: {
      type: String,
      enum: ["debit", "credit"],
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "VND" },
    balance_after: { type: Number, required: true },
    description: { type: String, default: "" },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true, versionKey: false, collection: "ledger_entries" }
);

LedgerEntrySchema.index({ journal_id: 1 });
LedgerEntrySchema.index({ account_id: 1, createdAt: -1 });
LedgerEntrySchema.index({ order_id: 1, createdAt: -1 });

module.exports = mongoose.model("LedgerEntry", LedgerEntrySchema);
