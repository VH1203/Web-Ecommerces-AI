const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const PaymentSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: () => `pay-${uuidv4()}`,
    },
    order_id: { type: String, ref: "Order", required: true },
    user_id: { type: String, ref: "User", required: true },
    shop_id: { type: String, ref: "User" },
    gateway: {
      type: String,
      enum: ["PAYPAL", "VNPAY", "COD"],
      required: true,
    },
    method: {
      type: String,
      enum: ["cod", "paypal", "vnpay"],
      required: true,
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: "VND" },
    status: {
      type: String,
      enum: ["pending", "success", "failed", "refunded"],
      default: "pending",
    },
    // PayPal-specific fields
    paypal_order_id:   { type: String, index: true },
    paypal_capture_id: { type: String },
    paid_at:           { type: Date },
    // VNPAY-specific fields
    vnpay_txn_ref:        { type: String, index: true }, // txnRef sent to VNPAY (= order_code)
    vnpay_transaction_no: { type: String },              // vnp_TransactionNo returned by VNPAY
    vnpay_bank_code:      { type: String },              // vnp_BankCode (e.g., "NCB", "VCB")
    // Legacy / shared fields
    provider_txn_id:   String,
    idempotency_key:   String,
    webhook_verified:  { type: Boolean, default: false },
    return_url:        String,
    expires_at:        Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", PaymentSchema);
