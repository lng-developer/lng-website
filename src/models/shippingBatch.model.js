// models/shippingBatch.model.js
const mongoose = require("mongoose");

const FakeItemSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true },
    tracking: { type: String },
    note: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CompletedItemSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true },
    tracking: { type: String, required: true },
    carrier: { type: String, default: "" },
    trackingReceivedAt: { type: Date, default: null },
    shipDate: { type: String, default: "" },

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

const TrackingReviewSchema = new mongoose.Schema(
  {
    approvedAt: { type: Date },
    shipDate: { type: String },
    confirmedSingleShipment: { type: Boolean, default: false },
    confirmedNoTransparency: { type: Boolean, default: false },
  },
  { _id: false }
);

const AmazonFeedSchema = new mongoose.Schema(
  {
    amazonBatchId: { type: String, default: "" },
    status: {
      type: String,
      enum: ["submitted", "processing", "done", "failed", "needs_review"],
      default: null,
    },
    submittedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    recordsProcessed: { type: Number, default: 0 },
    recordsActivated: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    warningCount: { type: Number, default: 0 },
    reportText: { type: String, default: "" },
    reportSha256: { type: String, default: "" },
    failureReason: { type: String, default: "" },
  },
  { _id: false }
);

const ShippingBatchSchema = new mongoose.Schema(
  {
    machineId: { type: String, required: true },
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", default: null, index: true },
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

    // Shipping confirmations require an explicit human review before dispatch.
    review: { type: TrackingReviewSchema, default: () => ({}) },

    // Amazon's own Processing Report is the final delivery evidence.
    amazonFeed: { type: AmazonFeedSchema, default: () => ({}) },

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
// Tối ưu _buildSubmissionMap: filter machineId + match orderId trong completed[]
ShippingBatchSchema.index({ machineId: 1, "completed.orderId": 1 });

const ShippingBatch = mongoose.model("ShippingBatch", ShippingBatchSchema);

module.exports = ShippingBatch;
