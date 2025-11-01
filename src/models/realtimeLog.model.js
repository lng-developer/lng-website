// models/realtimeLog.model.js
const mongoose = require("mongoose");

const RealtimeLogSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Types.ObjectId, ref: "shop", index: true },
    machineId: { type: String, index: true },
    label: { type: String, default: null },

    action: { type: String, enum: ["click", "auto"], required: true },
    type: { type: String, default: "import_order", index: true },
    level: {
      type: String,
      enum: ["info", "success", "error"],
      default: "info",
    },

    message: { type: String, required: true },
    ts: { type: Date, default: Date.now, index: true },

    jobId: { type: String, index: true }, // để nhóm log cho 1 lượt import
    meta: { type: mongoose.Schema.Types.Mixed }, // tuỳ chọn, nếu cần thêm chi tiết
  },
  { versionKey: false }
);

module.exports = mongoose.model(
  "RealtimeLog",
  RealtimeLogSchema,
  "apo_realtime_logs"
);
