const mongoose = require("mongoose");

const RealtimeLogSchema = new mongoose.Schema(
  {
    ts: { type: Number, index: true }, // timestamp ms
    day: { type: String, index: true }, // 'YYYY-MM-DD' để truy vấn theo ngày
    type: { type: String, index: true }, // CONNECT | HELLO | ACK | STATUS | RUN_NOW | ...
    // các trường hay lọc:
    clientId: { type: String, index: true },
    label: { type: String, index: true },
    socketId: String,
    jobId: { type: String, index: true },
    phase: { type: String, index: true }, // import | report | ads | config
    status: { type: String, index: true }, // start | success | fail
    ms: Number,
    error: String,
    meta: Object, // payload đầy đủ để debug

    // TTL (tuỳ chọn): auto xoá sau N ngày
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
