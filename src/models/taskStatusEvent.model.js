const mongoose = require("mongoose");

const taskStatusEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    taskId: { type: String, required: true, index: true },
    type: { type: String },
    status: {
      type: String,
      enum: ["received", "completed", "failed"],
      required: true,
    },
    shopId: { type: String, index: true },
    machineId: { type: String, index: true },
    source: { type: String },
    result: { type: mongoose.Schema.Types.Mixed },
    error: { type: mongoose.Schema.Types.Mixed },
    rawPayload: { type: mongoose.Schema.Types.Mixed },
    reportedAt: { type: Date },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    duplicateCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "taskStatusEvents" }
);

taskStatusEventSchema.index({ taskId: 1, status: 1 });
taskStatusEventSchema.index({ shopId: 1, machineId: 1 });
taskStatusEventSchema.index({ reportedAt: -1 });

module.exports = mongoose.model("TaskStatusEvent", taskStatusEventSchema);
