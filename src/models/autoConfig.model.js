const mongoose = require("mongoose");

const autoConfigSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["IMPORT_ORDER", "IMPORT_ADS", "IMPORT_FBM", "UPLOAD_TRACKING", "PULL_TRACKING"],
      required: true,
    },
    status: {
      type: Boolean,
      default: true,
    },
    time: {
      type: Number, // phút
      required: true,
    },
    scheduleHours: {
      type: [Number],
      default: [],
      validate: {
        validator: (hours) => Array.isArray(hours) && new Set(hours).size === hours.length && hours.every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23),
        message: "scheduleHours must contain unique whole hours from 0 to 23",
      },
    },
    shopId: {
      type: String,
      required: true,
    },
    shopName: {
      type: String,
      required: true,
    },
    shopType: {
      type: String,
      default: "",
    },
    describe: {
      type: String,
      default: "",
    },
    nextRunAt: { type: Date, default: null },
    lastDispatchedAt: { type: Date, default: null },
    lastTaskId: { type: String, default: "" },
    lastTaskStatus: { type: String, default: "" },
    lastTaskFinishedAt: { type: Date, default: null },
    lastTaskError: { type: String, default: "" },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

module.exports = mongoose.model("AutoConfig", autoConfigSchema);
