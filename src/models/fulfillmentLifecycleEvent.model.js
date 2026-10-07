const mongoose = require("mongoose");

const fulfillmentLifecycleEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true, index: true },
    tenantReference: { type: String, required: true, index: true },
    externalOrderId: { type: String, required: true, index: true },
    fulfillmentOrderId: { type: String, required: true, index: true },
    occurredAt: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: "fulfillmentLifecycleEvents" }
);

fulfillmentLifecycleEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model("FulfillmentLifecycleEvent", fulfillmentLifecycleEventSchema);
