// src/controllers/etsyAds.controller.js
const db = require("../models");
const EtsyAdsDailySummary = db.EtsyAdsDailySummary;
const EtsyOrder = db.EtsyOrder;
const mongoose = require("mongoose");

const utcDay = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v) => +toNum(v).toFixed(2);
const centsToUsd = (v) => round2(toNum(v) / 100);

const pickSkuFromOrderItem = (item) =>
  String(
    item?.sku ||
      item?.SKU ||
      item?.productSku ||
      item?.product_sku ||
      ""
  ).trim();

const pickListingIdFromOrderItem = (item) =>
  String(
    item?.listingId ||
      item?.listing_id ||
      item?.listingID ||
      ""
  ).trim();

const pickSellerFromOrder = (order) => {
  if (order?.seller?.sellerCode) return String(order.seller.sellerCode);
  if (order?.seller?.fullName) return String(order.seller.fullName);
  if (order?.seller?.name) return String(order.seller.name);
  if (typeof order?.seller === "string") return order.seller;
  return "";
};

async function buildListingSkuMapFromOrders(listingIds = [], shopId) {
  const ids = Array.from(new Set(listingIds.map(String).filter(Boolean)));
  const map = new Map();

  if (!ids.length) return map;

  const query = {
    "items.listingId": { $in: ids },
  };

  if (shopId && mongoose.Types.ObjectId.isValid(shopId)) {
    query.shopId = new mongoose.Types.ObjectId(shopId);
  }

  const orders = await EtsyOrder.find(query, {
    orderId: 1,
    seller: 1,
    items: 1,
  }).lean();

  for (const order of orders || []) {
    for (const item of order.items || []) {
      const lid = pickListingIdFromOrderItem(item);
      const sku = pickSkuFromOrderItem(item);
      if (!lid || !sku) continue;

      if (!map.has(lid)) {
        map.set(lid, {
          listingId: lid,
          sku,
          seller: pickSellerFromOrder(order),
          source: "etsy_order_items",
          orderId: order.orderId || "",
        });
      }
    }
  }

  return map;
}
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
      firstRowSample: Array.isArray(rows) && rows[0]
        ? {
            listingId: String(rows[0]?.listingId || ""),
            title: String(rows[0]?.title || "").slice(0, 80),
            spend: rows[0]?.spend,
            revenue: rows[0]?.revenue,
            orders: rows[0]?.orders,
            hasSku: !!String(rows[0]?.sku || rows[0]?.SKU || rows[0]?.productSku || "").trim(),
          }
        : null,
    });

    const adsListingIds = rows.map((r) => String(r?.listingId || "")).filter(Boolean);
    const listingSkuMap = await buildListingSkuMapFromOrders(adsListingIds, shopId);

    console.log("[ETSY_ADS_IMPORT][SKU_ENRICH_MAP]", {
      adsRows: rows.length,
      uniqueAdsListingIds: new Set(adsListingIds).size,
      matchedListingIdsFromOrders: listingSkuMap.size,
      missingListingIds: Array.from(new Set(adsListingIds)).filter((id) => !listingSkuMap.has(id)),
    });

    // ===== Normalize rows: cents -> USD =====
    // TODO: Create EtsyListingCatalog collection:
    // { shopId, etsyShopId, listingId, sku, title, sellerCode, updatedAt }
    // Ads import should lookup catalog first, then fallback orders.
    const normalized = rows
      .filter((r) => r && r.listingId)
      .map((r) => {
        const rowSku = String(r.sku || r.SKU || r.productSku || "").trim();
        const fallback = listingSkuMap.get(String(r.listingId));
        const finalSku = rowSku || fallback?.sku || "";
        const finalSeller = String(r.seller || r.sellerName || fallback?.seller || "").trim();

        return {
          date: r.date || day,
          listingId: String(r.listingId),
          title: r.title || "",
          state: r.state != null ? String(r.state) : "",
          sku: finalSku,
          seller: finalSeller,
          skuSource: rowSku ? "ads_payload" : fallback?.sku ? "orders_fallback" : "missing",
          spend: round2(toNum(r.spend) / 100),
          views: toNum(r.views),
          clicks: toNum(r.clicks),
          orders: toNum(r.orders),
          revenue: round2(toNum(r.revenue) / 100),
          roas: round2(r.roas),
          clickRate: round2(r.clickRate),
          rawStats: r.rawStats || null,
          rawListing: r.rawListing || null,
        };
      });

    const skuAudit = normalized.map((r) => ({
      listingId: r.listingId,
      title: String(r.title || "").slice(0, 80),
      sku: r.sku,
      seller: r.seller,
      skuSource: r.skuSource,
      spend: r.spend,
      orders: r.orders,
      revenue: r.revenue,
    }));

    console.log("[ETSY_ADS_IMPORT][SKU_ENRICH_RESULT]", {
      totalRows: skuAudit.length,
      fromAdsPayload: skuAudit.filter((x) => x.skuSource === "ads_payload").length,
      fromOrdersFallback: skuAudit.filter((x) => x.skuSource === "orders_fallback").length,
      missing: skuAudit.filter((x) => x.skuSource === "missing").length,
      missingRows: skuAudit.filter((x) => x.skuSource === "missing"),
      sample: skuAudit.slice(0, 30),
    });
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

    console.log("[ETSY_ADS_LIST][SKU_RESPONSE_CHECK]", {
      count: docs.length,
      docs: docs.slice(0, 3).map((doc) => {
        const rows = doc.rows || [];
        return {
          id: doc._id,
          day: doc.day,
          totalRows: rows.length,
          rowsWithSku: rows.filter((r) => !!r.sku).length,
          rowsMissingSku: rows.filter((r) => !r.sku).length,
          skuSourceCounts: rows.reduce((acc, r) => {
            const key = r.skuSource || "unknown";
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {}),
          sample: rows.slice(0, 10).map((r) => ({
            listingId: r.listingId,
            sku: r.sku,
            skuSource: r.skuSource,
          })),
        };
      }),
    });

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
