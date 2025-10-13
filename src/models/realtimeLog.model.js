const mongoose = require("mongoose");

const PhasedItemSchema = new mongoose.Schema(
  {
    // 'import' | 'report' | 'ads'
    type: { type: String, enum: ["import", "report", "ads"], required: true },
    // 'success' | 'fail'
    status: { type: String, enum: ["success", "fail"], required: true },
    // tuỳ chọn: thời gian chạy & lỗi của từng bước (nếu muốn log chi tiết)
    ms: { type: Number },
    error: { type: String },
  },
  { _id: false, versionKey: false }
);

const RealtimeLogSchema = new mongoose.Schema(
  {
    // mốc thời gian
    ts: { type: Number, index: true }, // timestamp ms
    day: { type: String, index: true }, // 'YYYY-MM-DD'

    /**
     * Loại bản ghi tổng:
     * - "AUTO": auto scheduler của extension
     * - "CLICK": người dùng bấm run now trên UI
     * (vẫn có thể có các loại cũ như "STATUS", "CONNECT" nếu code khác còn dùng)
     */
    type: { type: String, index: true },

    // định danh client/máy
    clientId: { type: String, index: true },
    label: { type: String, index: true },

    // tham chiếu shop nếu có (đang dùng _id của Shop)
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", index: true },

    // ---- MỚI: mảng kết quả từng pha của 1 lần chạy
    // [{ type:'import'|'report'|'ads', status:'success'|'fail', ... }]
    phases: { type: [PhasedItemSchema], default: undefined },

    // ---- GIỮ TƯƠNG THÍCH CŨ (tùy chọn): log đơn lẻ theo phase/status
    phase: { type: String, index: true }, // import | report | ads | config
    status: { type: String, index: true }, // start | success | fail
    ms: Number,
    error: String,

    // payload mở rộng
    meta: { type: Object },

    // TTL (tuỳ chọn): auto xoá sau N ngày
    expireAt: {
      type: Date,
      index: process.env.LOG_TTL_DAYS ? { expireAfterSeconds: 0 } : undefined,
      default: process.env.LOG_TTL_DAYS
        ? () =>
            new Date(
              Date.now() +
                Number(process.env.LOG_TTL_DAYS) * 24 * 60 * 60 * 1000
            )
        : undefined,
    },
  },
  { versionKey: false }
);

// Index gợi ý truy vấn phổ biến
RealtimeLogSchema.index({ day: 1, ts: 1 });
RealtimeLogSchema.index({ type: 1, day: 1, ts: 1 });
RealtimeLogSchema.index({ shopId: 1, day: 1, ts: 1 });
RealtimeLogSchema.index({ clientId: 1, day: 1, ts: 1 });

module.exports = mongoose.model(
  "RealtimeLog",
  RealtimeLogSchema,
  "apo_realtime_logs"
);
