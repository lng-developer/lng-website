// ===== Mongo models (thêm Job queue) =====
const mongoose = require("mongoose");

const JobSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["import"], required: true, index: true },
    // mốc cần chạy (đúng tick)
    dueAt: { type: Number, required: true, index: true },
    // khoảng thời gian import
    window: {
      from: { type: Number, required: true },
      to: { type: Number, required: true },
    },
    status: {
      type: String,
      enum: ["queued", "running", "done", "failed"],
      default: "queued",
      index: true,
    },
    assignedTo: { type: String, default: null }, // clientId|label
    attempts: { type: Number, default: 0 },
    lastError: String,
    // số liệu lại để audit
    metrics: {
      ms: Number,
      count: Number,
      created: Number,
      updated: Number,
      skipped: Number,
      reportId: String,
    },
    createdAt: { type: Number, default: () => Date.now(), index: true },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { versionKey: false }
);

module.exports = mongoose.model("Job", JobSchema, "jobs");
