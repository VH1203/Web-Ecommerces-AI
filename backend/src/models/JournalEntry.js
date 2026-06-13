const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const JournalEntrySchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => `jrn-${uuidv4()}` },
    type: {
      type: String,
      enum: [
        "payment_capture",
        "order_settlement",
        "refund",
        "wallet_deposit",
        "withdraw_reserve",
        "withdraw_approve",
        "withdraw_reject",
        "manual_adjustment",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["posted", "voided"],
      default: "posted",
    },
    idempotency_key: { type: String, required: true, unique: true },
    order_id: { type: String, ref: "Order" },
    payment_id: { type: String, ref: "Payment" },
    refund_id: { type: String, ref: "Refund" },
    transaction_id: { type: String, ref: "Transaction" },
    currency: { type: String, default: "VND" },
    total_debit: { type: Number, required: true },
    total_credit: { type: Number, required: true },
    description: { type: String, default: "" },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true, versionKey: false, collection: "journal_entries" }
);

JournalEntrySchema.index({ order_id: 1, type: 1 });
JournalEntrySchema.index({ createdAt: -1 });

module.exports = mongoose.model("JournalEntry", JournalEntrySchema);
