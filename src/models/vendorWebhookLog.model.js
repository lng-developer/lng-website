const mongoose = require("mongoose");

const vendorWebhookLogSchema = new mongoose.Schema(
  {
    provider: { type: String, index: true, required: true },
    outcome: {
      type: String,
      enum: ["success", "error", "skipped"],
      index: true,
      required: true,
    },
    httpStatus: { type: Number, index: true },
    message: { type: String, default: "" },

    orderId: { type: String, index: true, default: "" },
    externalId: { type: String, index: true, default: "" },
    eventStatus: { type: String, default: "" },
    tracking: { type: String, index: true, default: "" },
    carrier: { type: String, default: "" },

    matchedCollection: { type: String, enum: ["etsyorders", "ordercustomproducts", ""], default: "" },
    matchedItems: { type: Number, default: 0 },
    changedItems: { type: Number, default: 0 },
    orderStatusChanged: { type: Boolean, default: false },

    request: {
      method: { type: String, default: "" },
      path: { type: String, default: "" },
      ip: { type: String, default: "" },
      userAgent: { type: String, default: "" },
      signatureType: {
        type: String,
        enum: ["onos-hmac", "token", "bearer", "query-token", "none"],
        default: "none",
      },
    },

    error: {
      name: { type: String, default: "" },
      message: { type: String, default: "" },
      status: { type: Number, default: null },
      event: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    rawPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    collection: "vendorWebhookLogs",
  }
);

vendorWebhookLogSchema.index({ provider: 1, createdAt: -1 });
vendorWebhookLogSchema.index({ outcome: 1, createdAt: -1 });
vendorWebhookLogSchema.index({ orderId: 1, createdAt: -1 });
vendorWebhookLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

module.exports = mongoose.model("VendorWebhookLog", vendorWebhookLogSchema);
