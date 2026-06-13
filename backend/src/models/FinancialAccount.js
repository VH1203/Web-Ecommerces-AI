const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const FinancialAccountSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => `facct-${uuidv4()}` },
    owner_type: {
      type: String,
      enum: ["system", "shop", "customer", "gateway"],
      required: true,
    },
    owner_id: { type: String, required: true },
    account_type: {
      type: String,
      enum: [
        "gateway_clearing",
        "platform_escrow",
        "shop_payable",
        "platform_revenue",
        "customer_wallet",
        "shop_wallet",
        "payout_clearing",
      ],
      required: true,
    },
    currency: { type: String, default: "VND" },
    balance: { type: Number, default: 0 },
    is_active: { type: Boolean, default: true },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true, versionKey: false, collection: "financial_accounts" }
);

FinancialAccountSchema.index(
  { owner_type: 1, owner_id: 1, account_type: 1, currency: 1 },
  { unique: true }
);

module.exports = mongoose.model("FinancialAccount", FinancialAccountSchema);
