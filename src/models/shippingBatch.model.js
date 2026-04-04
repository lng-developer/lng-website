// models/shippingBatch.model.js
const mongoose = require("mongoose");

const FakeItemSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true },
    tracking: { type: String, required: true },
    note: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CompletedItemSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true },
    tracking: { type: String, required: true },

    isFake: { type: Boolean, default: false },
    source: {
      type: String,
      enum: ["system", "fake", "direct_query"], // ✅ Thêm direct_query
      default: "system",
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

const ShippingBatchSchema = new mongoose.Schema(
  {
    machineId: { type: String, required: true },
    label: { type: String },
    confirmShipDate: { type: Date },

    type: {
      type: String,
      enum: ["CONFIRM", "UPDATE_FAKE", "UPDATE_GLOBAL", "DIRECT_EXPORT"], // ✅ Thêm DIRECT_EXPORT
      default: "CONFIRM",
    },

    fileName: { type: String },

    status: {
      type: String,
      enum: ["CREATED", "CONFIRM_FILE_READY", "UPDATE_FAKE", "COMPLETED"], // ✅ Thêm COMPLETED
      default: "CREATED",
    },

    completed: [CompletedItemSchema],

    tracking_fakes: [FakeItemSchema],

    stats: { type: StatsSchema, default: () => ({}) },

    // ✅ Thêm field tracking upload task
    uploadTaskSent: { type: Boolean, default: false },
    uploadTaskSentAt: { type: Date },
    uploadTaskSentBy: { 
      type: String, 
      enum: ["auto", "frontend", "api", "cron"],
      default: "auto"
    },
  },
  {
    timestamps: true,
  }
);

ShippingBatchSchema.index({ machineId: 1, createdAt: -1 });
ShippingBatchSchema.index({ label: 1, createdAt: -1 });

const ShippingBatch = mongoose.model("ShippingBatch", ShippingBatchSchema);

module.exports = ShippingBatch;
