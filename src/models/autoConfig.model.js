const mongoose = require("mongoose");

const adsScheduleRuleSchema = new mongoose.Schema(
  {
    hour: { type: Number, required: true, min: 0, max: 23 },
    minute: { type: Number, required: true, min: 0, max: 59 },
    // Sunday=0 … Saturday=6. A daily rule contains all seven days.
    daysOfWeek: { type: [Number], required: true },
    startDaysAgo: { type: Number, required: true, min: 1, max: 31 },
    endDaysAgo: { type: Number, required: true, min: 1, max: 31 },
  },
  { _id: false }
);

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
    // IMPORT_ADS only: D-1 is yesterday in Vietnam time. Start is the older day.
    adsStartDaysAgo: { type: Number, default: 1, min: 1, max: 31 },
    adsEndDaysAgo: { type: Number, default: 1, min: 1, max: 31 },
    // IMPORT_ADS only. Takes precedence over legacy scheduleHours.
    adsScheduleRules: { type: [adsScheduleRuleSchema], default: [] },
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
