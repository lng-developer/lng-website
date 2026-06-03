const mongoose = require("mongoose");

const EtsyMessageEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, default: "" },
    reason: { type: String, default: "" },
    latestMessageBody: { type: String, default: "" },
    latestMessagePreview: { type: String, default: "" },
    lastMessageAt: { type: Date, default: null },
    receivedAt: { type: Date, default: Date.now },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const EtsyMessageThreadSchema = new mongoose.Schema(
  {
    shopId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    machineId: {
      type: String,
      default: "",
      index: true,
    },
    threadId: {
      type: String,
      required: true,
      trim: true,
    },
    buyerName: {
      type: String,
      default: "",
      trim: true,
    },
    buyerUsername: {
      type: String,
      default: "",
      trim: true,
    },
    orderId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    unread: {
      type: Boolean,
      default: false,
      index: true,
    },
    latestMessageBody: {
      type: String,
      default: "",
    },
    latestMessagePreview: {
      type: String,
      default: "",
    },
    sourceUrl: {
      type: String,
      default: "",
    },
    lastMessageAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastSyncedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    lastEventId: {
      type: String,
      default: "",
      index: true,
    },
    fingerprint: {
      type: String,
      default: "",
      index: true,
    },
    status: {
      type: String,
      enum: ["open", "read", "archived"],
      default: "open",
      index: true,
    },
    events: {
      type: [EtsyMessageEventSchema],
      default: [],
    },
    rawLastPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

EtsyMessageThreadSchema.index(
  { shopId: 1, threadId: 1 },
  { unique: true, name: "etsy_message_shop_thread_unique_idx" }
);

EtsyMessageThreadSchema.index(
  { shopId: 1, lastMessageAt: -1, updatedAt: -1 },
  { name: "etsy_message_shop_last_message_idx" }
);

module.exports = mongoose.model("EtsyMessageThread", EtsyMessageThreadSchema);
