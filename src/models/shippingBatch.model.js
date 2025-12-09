// models/shippingBatch.model.js
const mongoose = require("mongoose");

/**
 * Các đơn đang dùng tracking FAKE trong batch
 */
const FakeItemSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true }, // AmazonOrderId
    tracking: { type: String, required: true }, // fake tracking
    note: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Danh sách đầy đủ các đơn trong batch (cả fake lẫn real)
 * -> dùng để build file confirm ship gửi Amazon
 */
const CompletedItemSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true }, // AmazonOrderId
    tracking: { type: String, required: true }, // tracking hiện dùng để confirm

    isFake: { type: Boolean, default: false }, // true = tracking fake, false = tracking real
    source: {
      type: String,
      enum: ["system", "fake"],
      default: "system", // "system" = lấy từ hệ thống của bạn, "fake" = tự gen
    },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Stats để UI show nhanh
 */
const StatsSchema = new mongoose.Schema(
  {
    totalOrders: { type: Number, default: 0 },
    totalFake: { type: Number, default: 0 },
    totalReal: { type: Number, default: 0 },
  },
  { _id: false }
);

/**
 * ShippingBatch:
 * - Một lần request confirm ship = 1 batch
 * - completed: tất cả tracking (fake + real)
 * - tracking_fakes: chỉ những đơn đang dùng tracking fake
 */
const ShippingBatchSchema = new mongoose.Schema(
  {
    // Multi-client / multi-account
    machineId: { type: String, required: true }, // client/extension nào gửi
    label: { type: String, required: true }, // gắn với acc Amazon nào, ví dụ "US-main-1"

    type: {
      type: String,
      enum: ["CONFIRM", "UPDATE_FAKE"],
      default: "CONFIRM",
    },

    fileName: { type: String },

    status: {
      type: String,
      enum: ["CREATED", "CONFIRM_FILE_READY", "UPDATE_FAKE"],
      default: "CREATED",
    },

    // Chứa tất cả tracking (fake + real)
    completed: [CompletedItemSchema],

    // Chỉ các order đang dùng fake tracking
    tracking_fakes: [FakeItemSchema],

    stats: { type: StatsSchema, default: () => ({}) },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

ShippingBatchSchema.index({ machineId: 1, createdAt: -1 });
ShippingBatchSchema.index({ label: 1, createdAt: -1 });

const ShippingBatch = mongoose.model("ShippingBatch", ShippingBatchSchema);

module.exports = ShippingBatch;
