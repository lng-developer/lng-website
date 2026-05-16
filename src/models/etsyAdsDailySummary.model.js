// src/models/etsyAdsDailySummary.model.js
const mongoose = require("mongoose");

const EtsyAdRowSchema = new mongoose.Schema(
  {
    date: { type: String },                  // "YYYY-MM-DD" giữ nguyên từ extension
    listingId: { type: String, required: true, index: true },
    title: { type: String },
    state: { type: String },
    sku: { type: String, default: "" },
    seller: { type: String, default: "" },
    skuSource: { type: String, default: "missing" },
    spend: { type: Number, default: 0 },     // USD (đã /100 từ cents)
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },   // USD
    roas: { type: Number, default: 0 },
    clickRate: { type: Number, default: 0 },
    rawStats: { type: mongoose.Schema.Types.Mixed },
    rawListing: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const EtsyAdsDailySummarySchema = new mongoose.Schema(
  {
    day: { type: Date, required: true },       // 00:00 UTC
    shopId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
    },
    etsyShopId: { type: String },              // external id Etsy
    shopName: { type: String },

    rows: { type: [EtsyAdRowSchema], default: [] },

    // Tổng hợp nhanh (để query report khỏi loop rows)
    totalSpend: { type: Number, default: 0 },
    totalViews: { type: Number, default: 0 },
    totalClicks: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    roas: { type: Number, default: 0 },
    totalsSource: { type: String, default: "listing_rows_sum_fallback" },
    overviewApiDate: { type: String, default: null },
    overviewTotals: { type: mongoose.Schema.Types.Mixed, default: null },
    sourceMeta: { type: mongoose.Schema.Types.Mixed, default: null },
    rawOverview: { type: mongoose.Schema.Types.Mixed, default: null },
    totalRows: { type: Number, default: 0 },

    lastImportedAt: { type: Date },
  },
  { timestamps: true }
);

// Idempotent theo (day, shopId)
EtsyAdsDailySummarySchema.index({ day: 1, shopId: 1 }, { unique: true });

module.exports = mongoose.model("EtsyAdsDailySummary", EtsyAdsDailySummarySchema);
