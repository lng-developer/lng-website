const mongoose = require("mongoose");

const orderLifecycleEventSchema = new mongoose.Schema(
  {
    platform: { type: String, required: true, index: true },
    orderId: { type: String, required: true, index: true },
    orderObjectId: { type: mongoose.Schema.Types.ObjectId, default: null },
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", default: null, index: true },
    stage: { type: String, required: true, index: true },
    eventType: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["started", "success", "failed", "warning", "info"],
      required: true,
      index: true,
    },
    actorType: { type: String, default: "system" },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, default: "" },
    entityType: { type: String, default: "order" },
    entityId: { type: String, default: "" },
    message: { type: String, default: "" },
    reason: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: "orderLifecycleEvents" }
);

orderLifecycleEventSchema.index({ orderId: 1, occurredAt: -1 });
orderLifecycleEventSchema.index({ platform: 1, stage: 1, status: 1, occurredAt: -1 });
orderLifecycleEventSchema.index({ shopId: 1, occurredAt: -1 });
orderLifecycleEventSchema.index({ eventType: 1, occurredAt: -1 });
orderLifecycleEventSchema.index({ occurredAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model("OrderLifecycleEvent", orderLifecycleEventSchema);
