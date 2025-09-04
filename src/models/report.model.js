// models/ReportDaily.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Report theo NGÀY cho từng seller.
 * - seller: ref User
 * - day: chốt về 00:00 UTC (unique cùng seller)
 * - orders: danh sách Order góp vào báo cáo (để truy vết)
 * - totalOrders: số đơn trong ngày
 * - orderAmount: tổng tiền của các đơn (có thể trùng với revenue nếu bạn dùng revenue làm doanh thu)
 * - items/revenue/baseCost/ads/fee/opCost/refund: các thành phần để tính profit
 * - profit1 = revenue - baseCost - fee
 * - profit2 = profit1 - ads - opCost - refund
 * - roi = profit1 / (ads + baseCost)
 */
const ReportDailySchema = new Schema(
  {
    seller: {
      _id: { type: Schema.Types.ObjectId, ref: "User", required: true },
      full_name: { type: String, required: true },
    },
    day: { type: Date, required: true, index: true }, // ngày (00:00 UTC)
    // số liệu chính để hiển thị như bảng
    items: { type: Number, default: 0 }, // Total Items (tổng quantity)
    revenue: { type: Number, default: 0 },
    baseCost: { type: Number, default: 0 },
    ads: { type: Number, default: 0 }, // Ads spend
    fee: { type: Number, default: 0 },
    opCost: { type: Number, default: 0 }, // Operation Cost
    refund: { type: Number, default: 0 },

    // các trường tính sẵn (denormalized để query nhanh)
    profit1: { type: Number, default: 0 },
    profit2: { type: Number, default: 0 },
    roi: { type: Number, default: 0 }, // % (vd 65.12)
  },
  { timestamps: true }
);

// Mỗi seller chỉ có 1 report cho 1 ngày
ReportDailySchema.index({ seller: 1, day: 1 }, { unique: true });

// Tự tính profit/roi nếu chưa set (hoặc bạn có thể luôn ghi đè khi upsert)
ReportDailySchema.pre("save", function (next) {
  const r = this;
  const profit1 = (r.revenue || 0) - (r.baseCost || 0) - (r.fee || 0);
  const profit2 = profit1 - (r.ads || 0) - (r.opCost || 0) - (r.refund || 0);
  const denom = (r.ads || 0) + (r.baseCost || 0);
  const roi = denom ? (profit1 / denom) * 100 : 0;
  r.profit1 = Number(profit1.toFixed(2));
  r.profit2 = Number(profit2.toFixed(2));
  r.roi = Number(roi.toFixed(2));
  next();
});

module.exports = mongoose.model("Report", ReportDailySchema);
