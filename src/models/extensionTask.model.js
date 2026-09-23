const mongoose = require("mongoose");

const extensionTaskSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true },
    shopId: { type: String, index: true, default: null },
    machineId: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    status: {
      type: String,
      enum: ["queued", "sent", "received", "completed", "failed"],
      default: "sent",
      index: true,
    },
    sentAt: { type: Date, default: Date.now },
    ackedAt: { type: Date },
    completedAt: { type: Date },
    result: { type: mongoose.Schema.Types.Mixed },
    lastError: { type: mongoose.Schema.Types.Mixed },
    resendCount: { type: Number, default: 0 },
    lastResentAt: { type: Date },
  },
  { timestamps: true, collection: "extensionTasks" }
);

extensionTaskSchema.index({ machineId: 1, status: 1, createdAt: -1 });
extensionTaskSchema.index({ shopId: 1, status: 1 });

// Auto purge sau 14 ngày để collection không phình
extensionTaskSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 14 * 24 * 60 * 60 }
);

module.exports = mongoose.model("ExtensionTask", extensionTaskSchema);
