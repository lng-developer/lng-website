// models/configAuto.model.js
const mongoose = require("mongoose");

const ConfigAutoSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    type: {
      type: String,
      required: true,
      enum: ["vendorSyncBatch", "autoRequestExtension", "uploadTracking", "updateFakeTracking", "other"],
      default: "vendorSyncBatch"
    },
    autoTime: {
      type: String,
      required: true,
      trim: true,
      // Cron pattern format: "*/30 * * * *" (every 30 minutes)
      // Examples:
      // "*/5 * * * *" - every 5 minutes
      // "0 */2 * * *" - every 2 hours
      // "0 8,14,20 * * *" - at 8AM, 2PM, 8PM daily
      validate: {
        validator: function(v) {
          // Basic cron pattern validation (5 parts separated by spaces)
          const cronRegex = /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|[0-6]|\*\/[0-6])$/;
          return cronRegex.test(v);
        },
        message: 'autoTime must be a valid cron pattern (e.g., "*/30 * * * *")'
      }
    },
    status: {
      type: Boolean,
      required: true,
      default: false
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500
    },
    // Thêm các config tùy chọn cho từng loại auto
    config: {
      // Cho vendorSyncBatch
      maxOrders: {
        type: Number,
        default: 100,
        min: 1,
        max: 1000
      },
      dryRun: {
        type: Boolean,
        default: false
      },
      // Cho autoRequestExtension
      taskType: {
        type: String,
        enum: ["IMPORT_ORDERS", "IMPORT_ADS_SPEND", "IMPORT_FBM_ORDERS"],
        default: "IMPORT_ORDERS"
      },
      payload: {
        type: mongoose.Schema.Types.Mixed, // Có thể là object hoặc null
        default: null
      },
      // Cho uploadTracking
      maxBatches: {
        type: Number,
        default: 10,
        min: 1,
        max: 100
      },
      carrierCode: {
        type: String,
        default: "USPS"
      },
      shipMethod: {
        type: String,
        default: "USPS First Class"
      },
      // Có thể thêm các config khác tùy theo type
    },
    // Thống kê
    stats: {
      totalRuns: {
        type: Number,
        default: 0
      },
      lastRunAt: {
        type: Date
      },
      lastRunStatus: {
        type: String,
        enum: ["success", "error", "running"],
        default: null
      },
      lastRunResult: {
        type: mongoose.Schema.Types.Mixed // Lưu kết quả của lần chạy cuối
      }
    }
  },
  {
    timestamps: true,
  }
);

// Index cho tìm kiếm nhanh
ConfigAutoSchema.index({ type: 1, status: 1 });
ConfigAutoSchema.index({ id: 1 }, { unique: true });

const ConfigAuto = mongoose.model("ConfigAuto", ConfigAutoSchema);

module.exports = ConfigAuto;