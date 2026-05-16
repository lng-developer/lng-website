// src/controllers/etsyAds.controller.js
const db = require("../models");
const EtsyAdsDailySummary = db.EtsyAdsDailySummary;
const mongoose = require("mongoose");

const utcDay = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v) => +toNum(v).toFixed(2);
const centsToUsd = (v) => round2(toNum(v) / 100);

/**
 * POST /api/etsy-ads
 * Body (gửi từ extension):
 * {
 *   shopId:     "<ObjectId>",       // Shop._id nội bộ — bắt buộc
 *   platform:   "etsy",             // optional
 *   day:        "YYYY-MM-DD",       // bắt buộc
 *   etsyShopId: "64017969",         // optional, external id
 *   shopName:   "LilTonStore",      // optional
 *   rows: [{
 *     date, listingId, title, state,
 *     spend, views, clicks, orders, revenue, roas, clickRate,
 *     rawStats, rawListing,
 *   }]
 * }
 *
 * Quy ước đơn vị: spend/revenue gửi tới là CENTS (số nguyên), backend tự
 * chia 100 để lưu USD.
 *
 * Idempotent theo (day, shopId) — gọi lại sẽ ghi đè record cùng ngày + shop.
 */
const importEtsyAds = async (req, res) => {
  try {
    const {
      shopId,
      platform,
      day,
      etsyShopId,
      shopName,
      rows = [],
      summary = null,
      sourceMeta = null,
      raw = null,
    } = req.body || {};

    // ===== Validate =====
    if (!shopId) {
      return res.status(400).json({ ok: false, message: "shopId is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(shopId)) {
      return res.status(400).json({ ok: false, message: "shopId invalid" });
    }
    if (!day) {
      return res.status(400).json({ ok: false, message: "day is required (YYYY-MM-DD)" });
    }
    if (platform && String(platform).toLowerCase() !== "etsy") {
      return res.status(400).json({ ok: false, message: `platform must be "etsy" (got "${platform}")` });
    }
    const dayDate = new Date(day);
    if (isNaN(dayDate.getTime())) {
      return res.status(400).json({ ok: false, message: "day invalid format" });
    }
    const dayUTC = utcDay(dayDate);

    if (!Array.isArray(rows)) {
      return res.status(400).json({ ok: false, message: "rows must be an array" });
    }

    console.log("[ETSY_ADS_IMPORT][INCOMING]", {
      day,
      etsyShopId,
      shopName,
      rowsCount: Array.isArray(rows) ? rows.length : 0,
      hasSummary: !!summary,
      hasSourceMeta: !!sourceMeta,
      hasRawOverview: !!raw?.overview,
      summaryOverviewSource: summary?.overviewSource,
      sourceMetaOverviewSource: sourceMeta?.overviewSource,
      contentSourceMetaOverviewSource: sourceMeta?.contentSourceMeta?.overviewSource,
      firstRow: Array.isArray(rows) ? rows[0] : null,
    });

    // ===== Normalize rows: cents → USD =====
    const normalized = rows
      .filter((r) => r && r.listingId)
      .map((r) => ({
        date: r.date || day,
        listingId: String(r.listingId),
        title: r.title || "",
        state: r.state != null ? String(r.state) : "",
        spend: round2(toNum(r.spend) / 100),
        views: toNum(r.views),
        clicks: toNum(r.clicks),
        orders: toNum(r.orders),
        revenue: round2(toNum(r.revenue) / 100),
        roas: round2(r.roas),
        clickRate: round2(r.clickRate),
        rawStats: r.rawStats || null,
        rawListing: r.rawListing || null,
      }));

    // ===== Aggregate =====
    const totals = normalized.reduce(
      (acc, r) => {
        acc.totalSpend += r.spend;
        acc.totalViews += r.views;
        acc.totalClicks += r.clicks;
        acc.totalOrders += r.orders;
        acc.totalRevenue += r.revenue;
        return acc;
      },
      { totalSpend: 0, totalViews: 0, totalClicks: 0, totalOrders: 0, totalRevenue: 0 }
    );

    const effectiveSummary =
      summary ||
      sourceMeta?.contentSummary ||
      null;

    const effectiveSourceMeta =
      sourceMeta?.contentSourceMeta ||
      sourceMeta ||
      null;

    const hasOverviewSummary = !!(
      effectiveSummary &&
      (
        effectiveSummary.overviewSource === "etsy_ads_overview_api" ||
        effectiveSourceMeta?.overviewSource === "etsy_ads_overview_api" ||
        sourceMeta?.contentSourceMeta?.overviewSource === "etsy_ads_overview_api"
      )
    );

    const saveTotals = hasOverviewSummary
      ? {
          totalSpend: centsToUsd(effectiveSummary.totalSpend),
          totalRevenue: centsToUsd(effectiveSummary.totalRevenue),
          totalViews: toNum(effectiveSummary.totalViews),
          totalClicks: toNum(effectiveSummary.totalClicks),
          totalOrders: toNum(effectiveSummary.totalOrders),
          roas: round2(effectiveSummary.roas),
          totalsSource: "etsy_ads_overview_api",
          overviewApiDate:
            effectiveSummary.overviewApiDate ||
            effectiveSourceMeta?.overviewApiDate ||
            effectiveSourceMeta?.etsyApiDate ||
            sourceMeta?.etsyApiDate ||
            null,
          overviewTotals: {
            spendCents: toNum(effectiveSummary.totalSpend),
            spendUsd: centsToUsd(effectiveSummary.totalSpend),
            revenueCents: toNum(effectiveSummary.totalRevenue),
            revenueUsd: centsToUsd(effectiveSummary.totalRevenue),
            views: toNum(effectiveSummary.totalViews),
            clicks: toNum(effectiveSummary.totalClicks),
            orders: toNum(effectiveSummary.totalOrders),
            roas: round2(effectiveSummary.roas),
          },
        }
      : {
          totalSpend: round2(totals.totalSpend),
          totalRevenue: round2(totals.totalRevenue),
          totalViews: totals.totalViews,
          totalClicks: totals.totalClicks,
          totalOrders: totals.totalOrders,
          roas: totals.totalSpend > 0 ? round2(totals.totalRevenue / totals.totalSpend) : 0,
          totalsSource: "listing_rows_sum_fallback",
          overviewApiDate: null,
          overviewTotals: null,
        };

    console.log("[ETSY_ADS_IMPORT][TOTALS_COMPARE]", {
      day,
      hasOverviewSummary,
      rowsTotals: {
        totalSpend: round2(totals.totalSpend),
        totalRevenue: round2(totals.totalRevenue),
        totalViews: totals.totalViews,
        totalClicks: totals.totalClicks,
        totalOrders: totals.totalOrders,
      },
      summaryTotals: effectiveSummary ? {
        totalSpendRaw: effectiveSummary.totalSpend,
        totalSpendUsd: centsToUsd(effectiveSummary.totalSpend),
        totalRevenueRaw: effectiveSummary.totalRevenue,
        totalRevenueUsd: centsToUsd(effectiveSummary.totalRevenue),
        totalViews: effectiveSummary.totalViews,
        totalClicks: effectiveSummary.totalClicks,
        totalOrders: effectiveSummary.totalOrders,
        roas: effectiveSummary.roas,
        overviewSource: effectiveSummary.overviewSource,
        overviewApiDate: effectiveSummary.overviewApiDate,
      } : null,
      saveTotals,
    });

    // ===== Upsert =====
    const doc = await EtsyAdsDailySummary.findOneAndUpdate(
      { day: dayUTC, shopId: new mongoose.Types.ObjectId(shopId) },
      {
        $set: {
          day: dayUTC,
          shopId: new mongoose.Types.ObjectId(shopId),
          etsyShopId: etsyShopId || null,
          shopName: shopName || null,
          rows: normalized,
          totalSpend: saveTotals.totalSpend,
          totalViews: saveTotals.totalViews,
          totalClicks: saveTotals.totalClicks,
          totalOrders: saveTotals.totalOrders,
          totalRevenue: saveTotals.totalRevenue,
          roas: saveTotals.roas,
          totalsSource: saveTotals.totalsSource,
          overviewApiDate: saveTotals.overviewApiDate,
          overviewTotals: saveTotals.overviewTotals,
          sourceMeta: sourceMeta || null,
          rawOverview: raw?.overview || null,
          totalRows: normalized.length,
          lastImportedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log("[ETSY_ADS_IMPORT][SAVED_DOC_TOTALS]", {
      id: doc?._id,
      day: doc?.day,
      etsyShopId: doc?.etsyShopId,
      totalSpend: doc?.totalSpend,
      totalRevenue: doc?.totalRevenue,
      totalViews: doc?.totalViews,
      totalClicks: doc?.totalClicks,
      totalOrders: doc?.totalOrders,
      roas: doc?.roas,
      totalsSource: doc?.totalsSource,
      overviewApiDate: doc?.overviewApiDate,
      totalRows: doc?.totalRows,
    });

    return res.json({
      ok: true,
      message: "Etsy ads imported (idempotent by day + shopId)",
      day: dayUTC,
      shopId,
      etsyShopId: etsyShopId || null,
      shopName: shopName || null,
      rowsAccepted: normalized.length,
      rowsRejected: rows.length - normalized.length,
      totalSpend: doc.totalSpend,
      totalViews: doc.totalViews,
      totalClicks: doc.totalClicks,
      totalOrders: doc.totalOrders,
      totalRevenue: doc.totalRevenue,
      roas: doc.roas,
      totalsSource: doc.totalsSource,
      overviewApiDate: doc.overviewApiDate,
      overviewTotals: doc.overviewTotals,
      docId: doc._id,
    });
  } catch (err) {
    console.error("[etsyAds.import] error:", err);
    return res.status(500).json({
      ok: false,
      message: "Import Etsy ads failed",
      error: err.message,
    });
  }
};

/**
 * GET /api/etsy-ads?from=YYYY-MM-DD&to=YYYY-MM-DD&shopId=<id>
 * Liệt kê các day summary trong range.
 */
const listEtsyAds = async (req, res) => {
  try {
    const { from, to, shopId } = req.query;
    const q = {};
    if (from || to) {
      q.day = {};
      if (from) q.day.$gte = utcDay(new Date(from));
      if (to) q.day.$lte = utcDay(new Date(to));
    }
    if (shopId && mongoose.Types.ObjectId.isValid(shopId)) {
      q.shopId = new mongoose.Types.ObjectId(shopId);
    }

    const docs = await EtsyAdsDailySummary.find(q)
      .select("-rows.rawStats -rows.rawListing")  // exclude raw để gọn
      .sort({ day: -1 })
      .lean();

    return res.json({ ok: true, count: docs.length, items: docs });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

/**
 * GET /api/etsy-ads/:id
 * Detail 1 doc đầy đủ kèm rawStats + rawListing cho từng row.
 */
const getEtsyAdsDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, message: "id invalid" });
    }
    const doc = await EtsyAdsDailySummary.findById(id).lean();
    if (!doc) {
      return res.status(404).json({ ok: false, message: "Not found" });
    }
    return res.json({ ok: true, item: doc });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

module.exports = {
  importEtsyAds,
  listEtsyAds,
  getEtsyAdsDetail,
};
