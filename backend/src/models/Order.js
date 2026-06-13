// src/models/Order.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const OrderItemSchema = require("./OrderItemSchema");

/**
 * OrderSchema
 * - Đơn hàng của khách hàng (thuộc 1 shop)
 * - Liên kết với User, Address, Voucher, Payment, Shipper
 */
const OrderSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => `ord-${uuidv4()}` },
    order_code: { type: String, required: true, unique: true },
    user_id: { type: String, ref: "User", required: true },
    shop_id: { type: String, ref: "Shop", required: true },

    items: [OrderItemSchema],

    address_id: { type: String, ref: "Address" },
    voucher_id: { type: String, ref: "Voucher" },
    shipping_voucher_id: { type: String, ref: "Voucher" },

    payment_method: {
      type: String,
      enum: ["COD", "PAYPAL", "VNPAY", "WALLET"],
      default: "COD",
    },
    payment_status: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },
    financial_status: {
      type: String,
      enum: ["unpaid", "captured", "escrowed", "settled", "partially_refunded", "refunded"],
      default: "unpaid",
    },
    settled_at: { type: Date, default: null },

    shipping_provider: { type: String, enum: ["GHN", "GHTK", "NONE"], default: "NONE" },
    shipping_fee: { type: Number, default: 0 },
    tracking_code: { type: String },
    expected_delivery: { type: Date },

    // GHN integration fields
    ghn_order_code: { type: String, default: null },
    cancel_reason:  { type: String, default: "" },

    // Audit trail for status changes
    status_history: [
      {
        status: { type: String },
        at:     { type: Date, default: Date.now },
        by:     { type: String, default: "system" },
        note:   { type: String, default: "" },
      },
    ],

    total_price: { type: Number, required: true },
    discount:     { type: Number, default: 0 },   // voucher discount applied to this order
    credits_used: { type: Number, default: 0 },   // shop credits deducted
    note: { type: String },

    status: {
      type: String,
      enum: [
        // New statuses
        "order_created",
        "payment_pending",
        "payment_failed",
        "payment_confirmed",
        "processing",
        "packed",
        "picking",
        "in_transit",
        "out_for_delivery",
        "delivered",
        "delivery_failed",
        "cancelled_by_customer",
        "cancelled_by_shop",
        "return_requested",
        "return_approved",
        "return_rejected",
        "return_completed",
        "refund_pending",
        "refund_completed",
        // Legacy statuses (backward compat)
        "pending",
        "confirmed",
        "shipping",
        "canceled_by_customer",
        "canceled_by_shop",
      ],
      default: "order_created",
    },

    // Snapshot of the delivery address at order time.
    // Stored so order history remains correct even if the address is later edited or deleted.
    shipping_address: { type: Object, default: null },

    inventory_adjusted: { type: Boolean, default: false },
    created_by: { type: String, ref: "User" },
  },
  { timestamps: true, versionKey: false, collection: "orders" }
);

// NOTE: total_price is calculated by checkoutService (includes discounts + credits).
// Do NOT recalculate here — that would override voucher discounts.


// doanh thu theo danh muc san pham
OrderSchema.statics.getRevenueByCategory = async function () {
  return this.aggregate([
    { $unwind: "$items" },
    {
      $lookup: {
        from: "products",
        localField: "items.product_id",
        foreignField: "_id",
        as: "productInfo",
      },
    },
    { $unwind: "$productInfo" },
    {
      $lookup: {
        from: "categories",
        localField: "productInfo.category_id",
        foreignField: "_id",
        as: "categoryInfo",
      },
    },
    { $unwind: "$categoryInfo" },
    {
      $group: {
        _id: "$categoryInfo.name",
        totalRevenue: {
          $sum: {
            $add: [
              { $ifNull: ["$items.total", { $multiply: ["$items.price", "$items.qty"] }] },
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        name: "$_id",
        value: "$totalRevenue",
      },
    },
  ]);
};

module.exports = mongoose.model("Order", OrderSchema);
