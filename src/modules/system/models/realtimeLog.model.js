// models/realtimeLog.model.js
const mongoose = require("mongoose");

const RealtimeLogSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Types.ObjectId, ref: "Shop", index: true },
    machineId: { type: String, index: true },
    label: { type: String, default: null },
    action: { type: String, enum: ["click", "auto"], required: true },
    level: {
      type: String,
      enum: ["info", "success", "error"],
      default: "info",
    },

    message: { type: String, required: true },
    ts: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

module.exports = mongoose.model(
  "RealtimeLog",
  RealtimeLogSchema,
  "apo_realtime_logs"
);

