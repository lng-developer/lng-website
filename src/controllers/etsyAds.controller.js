// src/controllers/etsyAds.controller.js
const db = require("../models");
const EtsyAdsDailySummary = db.EtsyAdsDailySummary;
const { dedupeEtsyAdsDailySummaries } = require("../utils/etsyAds");
const EtsyOrder = db.EtsyOrder;
const User = db.user;
const SkuMappingConfig = db.SkuMappingConfig;
const EtsyListing = require("../models/etsyListing.model");
const mongoose = require("mongoose");
const { resolveMappedSku } = require("../utils/skuMigrate");

const utcDay = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v) => +toNum(v).toFixed(2);
const centsToUsd = (v) => round2(toNum(v) / 100);
const normalizeSellerKey = (value) => String(value || "").trim().toLowerCase();

const uniqueStrings = (values = []) =>
  Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));

const pickSkusFromAny = (item) =>
  uniqueStrings([
    item?.sku,
    item?.SKU,
    item?.productSku,
    item?.product_sku,
    item?.productIdentifier,
    item?.product_identifier,
    ...(Array.isArray(item?.skus) ? item.skus : []),
  ]);

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

const deriveSellerFromSku = (sku) => {
  const s = String(sku || "").trim();
  if (!s) return "";
  const token = s.split("-")[0]?.trim();
  return token || s.slice(0, 5);
};

const buildEmployeeLookup = (users = []) => {
  const map = new Map();

  for (const user of users || []) {
    const employeeCode = String(user?.employee_id || "").trim();
    const employeeName = String(user?.full_name || "").trim();
    const employeeInfo = {
      employeeId: user?._id ? String(user._id) : "",
      employeeCode,
      employeeName: employeeName || employeeCode || "Unknown",
    };

    if (employeeCode) map.set(normalizeSellerKey(employeeCode), employeeInfo);
    if (employeeName) map.set(normalizeSellerKey(employeeName), employeeInfo);
  }

  return map;
};

const buildEtsyAdsByEmployeeItems = (docs = [], users = []) => {
  const employeeLookup = buildEmployeeLookup(users);
  const grouped = new Map();

  for (const doc of docs || []) {
    for (const row of doc.rows || []) {
      const rawSeller = String(row?.seller || "").trim();
      const employeeInfo = employeeLookup.get(normalizeSellerKey(rawSeller));
      const employeeCode = employeeInfo?.employeeCode || rawSeller || "Unknown";
      const employeeName = employeeInfo?.employeeName || rawSeller || "Unknown";
      const groupKey = employeeInfo?.employeeCode || rawSeller || "Unknown";

      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {
          employeeCode,
          employeeName,
          sellerKey: groupKey,
          totals: {
            rows: 0,
            spend: 0,
            views: 0,
            clicks: 0,
            orders: 0,
            revenue: 0,
            roas: 0,
          },
          details: [],
        });
      }

      const group = grouped.get(groupKey);
      const detail = {
        day: doc.day,
        shopId: doc.shopId,
        etsyShopId: doc.etsyShopId,
        shopName: doc.shopName,
        ...row,
      };

      group.details.push(detail);
      group.totals.rows += 1;
      group.totals.spend = round2(group.totals.spend + toNum(row?.spend));
      group.totals.views += toNum(row?.views);
      group.totals.clicks += toNum(row?.clicks);
      group.totals.orders += toNum(row?.orders);
      group.totals.revenue = round2(group.totals.revenue + toNum(row?.revenue));
      group.totals.roas = group.totals.spend > 0 ? round2(group.totals.revenue / group.totals.spend) : 0;
    }
  }

  return Array.from(grouped.values()).sort((a, b) =>
    String(a.employeeCode || "").localeCompare(String(b.employeeCode || ""))
  );
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
          skus: [],
          seller: pickSellerFromOrder(order),
          source: "etsy_order_items",
          orderIds: [],
        });
      }
      const entry = map.get(lid);
      entry.skus = uniqueStrings([...entry.skus, sku]);
      entry.sku = entry.skus[0] || "";
      if (order.orderId && !entry.orderIds.includes(order.orderId)) entry.orderIds.push(order.orderId);
      if (!entry.orderId) entry.orderId = order.orderId || "";
      if (!entry.seller) entry.seller = pickSellerFromOrder(order);
    }
  }

  return map;
}

async function buildListingSkuMapFromListingMaster({ shopId, listingIds = [] } = {}) {
  const ids = Array.from(new Set(listingIds.map(String).filter(Boolean)));
  const map = new Map();

  if (!ids.length || !shopId || !mongoose.Types.ObjectId.isValid(shopId)) return map;

  const listings = await EtsyListing.find(
    {
      shopId: new mongoose.Types.ObjectId(shopId),
      listingId: { $in: ids },
    },
    {
      listingId: 1,
      SKU: 1,
      sku: 1,
      skus: 1,
      raw: 1,
      title: 1,
      TITLE: 1,
      etsyShopId: 1,
      syncedAt: 1,
    }
  ).lean();

  for (const listing of listings || []) {
    const lid = String(listing?.listingId || "").trim();
    const skus = uniqueStrings([
      listing?.SKU,
      listing?.sku,
      ...(Array.isArray(listing?.skus) ? listing.skus : []),
      listing?.raw?.SKU,
      listing?.raw?.sku,
      listing?.raw?.product_identifier,
      listing?.raw?.productIdentifier,
    ]);
    if (!lid || !skus.length) continue;

    map.set(lid, uniqueStrings([...(map.get(lid) || []), ...skus]));
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

    const now = new Date();
    const skuMappingConfigs = await SkuMappingConfig.find({
      is_active: true,
      $and: [
        { $or: [{ valid_from: null }, { valid_from: { $lte: now } }] },
        { $or: [{ valid_to: null }, { valid_to: { $gte: now } }] },
      ],
    }).sort({ priority: 1, updatedAt: -1 }).lean();

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
    const orderListingSkuMap = await buildListingSkuMapFromOrders(adsListingIds, shopId);
    const listingMasterSkuMap = await buildListingSkuMapFromListingMaster({ shopId, listingIds: adsListingIds });

    console.log("[ETSY_ADS_IMPORT][SKU_ENRICH_MAP]", {
      adsRows: rows.length,
      uniqueAdsListingIds: new Set(adsListingIds).size,
      matchedListingIdsFromOrders: orderListingSkuMap.size,
      matchedListingIdsFromListingMaster: listingMasterSkuMap.size,
      missingListingIds: Array.from(new Set(adsListingIds)).filter((id) => !orderListingSkuMap.has(id) && !listingMasterSkuMap.has(id)),
    });

    // ===== Normalize rows: cents -> USD =====
    const normalized = rows
      .filter((r) => r && r.listingId)
      .map((r) => {
        const rowSkus = pickSkusFromAny(r);
        const rowSku = rowSkus[0] || "";
        const orderFallback = orderListingSkuMap.get(String(r.listingId));
        const listingMasterSkus = listingMasterSkuMap.get(String(r.listingId)) || [];
        const finalSkus = rowSkus.length
          ? rowSkus
          : orderFallback?.skus?.length
            ? orderFallback.skus
            : listingMasterSkus.length
              ? listingMasterSkus
              : [];
        const finalSku = finalSkus[0] || "";
        const mappedSku = resolveMappedSku(finalSku, skuMappingConfigs);
        const skuSource = rowSku
          ? "ads_row"
          : orderFallback?.skus?.length
            ? "orders_fallback"
            : listingMasterSkus.length
              ? "listing_master"
              : "missing";
        const finalSeller = String(
          (mappedSku !== finalSku ? deriveSellerFromSku(mappedSku) : r.seller) ||
          r.sellerName ||
            orderFallback?.seller ||
            deriveSellerFromSku(finalSku)
        ).trim();

        return {
          date: r.date || day,
          listingId: String(r.listingId),
          title: r.title || "",
          state: r.state != null ? String(r.state) : "",
          sku: finalSku,
          skus: finalSkus,
          seller: finalSeller,
          skuSource,
          spend: round2(toNum(r.spend) / 100),
          views: toNum(r.views),
          clicks: toNum(r.clicks),
          orders: toNum(r.orders),
          revenue: round2(toNum(r.revenue) / 100),
          roas: round2(r.roas),
          clickRate: round2(r.clickRate),
        };
      });

    const skuAudit = normalized.map((r) => ({
      listingId: r.listingId,
      title: String(r.title || "").slice(0, 80),
      sku: r.sku,
      skus: r.skus,
      seller: r.seller,
      skuSource: r.skuSource,
      spend: r.spend,
      orders: r.orders,
      revenue: r.revenue,
    }));
    const sourceCounts = {
      fromAdsRow: normalized.filter((x) => x.skuSource === "ads_row").length,
      fromOrdersFallback: normalized.filter((x) => x.skuSource === "orders_fallback").length,
      fromListingMaster: normalized.filter((x) => x.skuSource === "listing_master").length,
      missing: normalized.filter((x) => x.skuSource === "missing").length,
    };

    console.log("[ETSY_ADS_IMPORT][SKU_ENRICH_RESULT]", {
      totalRows: skuAudit.length,
      fromAdsRow: sourceCounts.fromAdsRow,
      fromOrdersFallback: sourceCounts.fromOrdersFallback,
      fromListingMaster: sourceCounts.fromListingMaster,
      missing: sourceCounts.missing,
      missingRows: skuAudit.filter((x) => x.skuSource === "missing"),
      sample: skuAudit.slice(0, 30),
    });

    console.log("[ETSY_ADS_SKU_ENRICH_DEEP]", {
      shopId,
      day,
      totalRows: normalized.length,
      uniqueListingIds: new Set(adsListingIds).size,
      fromAdsRow: sourceCounts.fromAdsRow,
      fromOrdersFallback: sourceCounts.fromOrdersFallback,
      fromListingMaster: sourceCounts.fromListingMaster,
      missing: sourceCounts.missing,
      ordersFallbackMapSize: orderListingSkuMap.size,
      listingMasterMapSize: listingMasterSkuMap.size,
      missingListingIdsSample: Array.from(new Set(
        normalized.filter((x) => x.skuSource === "missing").map((x) => x.listingId)
      )).slice(0, 50).map((listingId) => {
        const row = normalized.find((x) => x.listingId === listingId);
        return {
          listingId,
          title: row?.title || "",
          spend: row?.spend || 0,
          orders: row?.orders || 0,
        };
      }),
      listingMasterMatchedSample: normalized
        .filter((x) => x.skuSource === "listing_master")
        .slice(0, 30)
        .map((x) => ({
          listingId: x.listingId,
          title: x.title,
          sku: x.sku,
          skus: x.skus,
        })),
      ordersFallbackMatchedSample: normalized
        .filter((x) => x.skuSource === "orders_fallback")
        .slice(0, 30)
        .map((x) => ({
          listingId: x.listingId,
          title: x.title,
          sku: x.sku,
          skus: x.skus,
        })),
      adsRowMatchedSample: normalized
        .filter((x) => x.skuSource === "ads_row")
        .slice(0, 20)
        .map((x) => ({
          listingId: x.listingId,
          title: x.title,
          sku: x.sku,
          skus: x.skus,
        })),
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
      rowsCount: rows.length,
      rowsAccepted: normalized.length,
      rowsRejected: rows.length - normalized.length,
      fromAdsRow: sourceCounts.fromAdsRow,
      fromOrdersFallback: sourceCounts.fromOrdersFallback,
      fromListingMaster: sourceCounts.fromListingMaster,
      missing: sourceCounts.missing,
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

    const docs = dedupeEtsyAdsDailySummaries(await EtsyAdsDailySummary.find(q)
      .select("-rows.rawStats -rows.rawListing -sourceMeta -rawOverview")
      .sort({ day: -1 })
      .lean());

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
 * GET /api/etsy-ads/by-employee?from=YYYY-MM-DD&to=YYYY-MM-DD&shopId=<id>
 * Cung param voi listEtsyAds, nhung group rows theo ma nhan vien.
 */
const listEtsyAdsByEmployee = async (req, res) => {
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

    const docs = dedupeEtsyAdsDailySummaries(await EtsyAdsDailySummary.find(q)
      .select("-rows.rawStats -rows.rawListing -sourceMeta -rawOverview")
      .sort({ day: -1 })
      .lean());

    const sellerKeys = uniqueStrings(
      docs.flatMap((doc) => (doc.rows || []).map((row) => row?.seller))
    );
    const users = sellerKeys.length
      ? await User.find(
          {
            $or: [
              { employee_id: { $in: sellerKeys } },
              { full_name: { $in: sellerKeys } },
            ],
          },
          { _id: 1, employee_id: 1, full_name: 1 }
        ).lean()
      : [];

    const items = buildEtsyAdsByEmployeeItems(docs, users);

    return res.json({
      ok: true,
      count: items.length,
      items,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

/**
 * GET /api/etsy-ads/:id
 * Detail 1 daily summary đã normalize.
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
  listEtsyAdsByEmployee,
  getEtsyAdsDetail,
  buildEtsyAdsByEmployeeItems,
};
