// models/realtimeLog.model.js
const mongoose = require("mongoose");

const RealtimeLogSchema = new mongoose.Schema(
  {
    ts: { type: Number, index: true },
    day: { type: String, index: true },

    type: { type: String, index: true }, // 'AUTO' | 'CLICK' | 'STATUS'
    clientId: { type: String, index: true },
    label: { type: String, index: true },

    // PHASES bây giờ là mảng [{type, status}]
    phase: [
      {
        type: {
          type: String,
          enum: ["import", "report", "ads"],
          required: true,
        },
        status: {
          type: String,
          enum: ["success", "fail", "running"],
          required: true,
        },
      },
    ],

    status: { type: String, index: true }, // overall

    // >>> THÊM TRƯỜNG THAM CHIẾU SHOP
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", index: true },

    ms: Number,
    error: String,
    meta: Object,

    expireAt: {
      type: Date,
      index: process.env.LOG_TTL_DAYS ? { expireAfterSeconds: 0 } : undefined,
    },
  },
  { versionKey: false }
);

RealtimeLogSchema.index({ day: 1, ts: 1 });
RealtimeLogSchema.index({ type: 1, ts: 1 });

module.exports = mongoose.model(
  "RealtimeLog",
  RealtimeLogSchema,
  "apo_realtime_logs"
);
