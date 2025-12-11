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
      enum: ["system", "fake"],
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
    label: { type: String, required: true },
    confirmShipDate: { type: Date },

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

    completed: [CompletedItemSchema],

    tracking_fakes: [FakeItemSchema],

    stats: { type: StatsSchema, default: () => ({}) },
  },
  {
    timestamps: true,
  }
);

ShippingBatchSchema.index({ machineId: 1, createdAt: -1 });
ShippingBatchSchema.index({ label: 1, createdAt: -1 });

const ShippingBatch = mongoose.model("ShippingBatch", ShippingBatchSchema);

module.exports = ShippingBatch;
