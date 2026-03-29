// src/modules/report/services/ads.service.js
const { parse } = require("csv-parse/sync");
const User = require("../../auth/models/user.model");
const AdsDailySummary = require("../models/ads.model");
const Shop = require("../../auth/models/shop.model");
const mongoose = require("mongoose");
const { Types } = mongoose;

const toNum = (v) => {
  if (typeof v === "number") return v;
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const cleaned = s.replace(/[\$, ]/g, "");
  const n = +cleaned;
  return Number.isFinite(n) ? n : 0;
};

const norm = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.trim(),
      typeof v === "string" ? v.trim() : v,
    ])
  );

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find(Boolean) || "";
  return firstLine.includes("\t") ? "\t" : ",";
}

const utcDay = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function mapSellersBySku(skus) {
  const codes = [
    ...new Set(
      skus
        .map((s) => (typeof s === "string" ? s.split("-")[0]?.trim().toUpperCase() : ""))
        .filter(Boolean)
    ),
  ];
  if (!codes.length) return { getBySku: () => null };

  const users = await User.find({ employee_id: { $in: codes } })
    .select("_id full_name employee_id")
    .lean();

  const byCode = new Map(users.map((u) => [String(u.employee_id).toUpperCase(), u]));
  return {
    getBySku(sku) {
      if (!sku || typeof sku !== "string") return null;
      const code = sku.split("-")[0]?.trim().toUpperCase();
      if (!code) return null;
      return byCode.get(code) || null;
    },
  };
}

const FALLBACK_USER_ID_RAW = "68b93ed3f02eed8dec002ee3";
const FALLBACK_USER_ID = Types.ObjectId.isValid(FALLBACK_USER_ID_RAW)
  ? new Types.ObjectId(FALLBACK_USER_ID_RAW)
  : FALLBACK_USER_ID_RAW;
const FALLBACK_USER_NAME = "Boss (Unattributed Ads)";

const importAdsForDay = async ({ day, shopId, fileBuffer }) => {
  const dayUTC = utcDay(new Date(day));

  const shopIdObj = Types.ObjectId.isValid(shopId) ? new Types.ObjectId(shopId) : shopId;
  const shopIdStr = String(shopId);

  const raw = fileBuffer.toString("utf8");
  const delimiter = detectDelimiter(raw);
  const rows = parse(raw, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: true,
  }).map(norm);
  if (!rows.length) return { message: "Empty file", upserts: 0 };

  const allSkusOrNames = rows.map((r) => r.Campaigns).filter(Boolean);
  const sellerMap = await mapSellersBySku(allSkusOrNames);

  const perSeller = new Map();
  let unmatchedCount = 0;

  for (const r of rows) {
    const campName = (r.Campaigns || "").trim();
    if (!campName) continue;

    const mappedSeller = sellerMap.getBySku(campName);
    let sellerId, sellerName;

    if (mappedSeller?._id) {
      sellerId = String(mappedSeller._id);
      sellerName = mappedSeller.full_name || "Unknown";
    } else {
      sellerId = String(FALLBACK_USER_ID);
      sellerName = FALLBACK_USER_NAME;
      unmatchedCount++;
    }

    const spend = toNum(r.Spend);
    if (!perSeller.has(sellerId)) {
      perSeller.set(sellerId, {
        seller: {
          _id: Types.ObjectId.isValid(sellerId) ? new Types.ObjectId(sellerId) : sellerId,
          full_name: sellerName,
        },
        spend: 0,
      });
    }
    perSeller.get(sellerId).spend += spend;
  }

  if (!perSeller.size) {
    return {
      message: "No matched rows.",
      day: dayUTC,
      sellers: 0,
      totalSpendDelta: 0,
      shopId: shopIdStr,
    };
  }

  for (const v of perSeller.values()) v.spend = +v.spend.toFixed(2);

  const existed = await AdsDailySummary.findOne({ day: dayUTC }).lean();

  const bySellerMap = new Map();
  if (existed?.by_seller?.length) {
    for (const s of existed.by_seller) {
      bySellerMap.set(String(s.seller._id), {
        seller: s.seller,
        spend: toNum(s.spend) || 0,
        by_shop: Array.isArray(s.by_shop)
          ? s.by_shop.map((x) => ({ shop_id: x.shop_id, spend: toNum(x.spend) || 0 }))
          : [],
      });
    }
  }

  for (const [sid, entry] of bySellerMap.entries()) {
    if (Array.isArray(entry.by_shop) && entry.by_shop.length) {
      entry.by_shop = entry.by_shop.filter((bs) => String(bs.shop_id) !== shopIdStr);
      entry.spend = +entry.by_shop.reduce((a, b) => a + toNum(b.spend || 0), 0).toFixed(2);
      bySellerMap.set(sid, entry);
    }
  }

  for (const { seller, spend } of perSeller.values()) {
    const sellerIdKey = String(seller._id);
    if (!bySellerMap.has(sellerIdKey)) {
      bySellerMap.set(sellerIdKey, { seller, spend: 0, by_shop: [] });
    }

    const entry = bySellerMap.get(sellerIdKey);
    entry.by_shop.push({ shop_id: shopIdObj, spend: +spend.toFixed(2) });
    entry.spend = +entry.by_shop.reduce((a, b) => a + toNum(b.spend || 0), 0).toFixed(2);
    bySellerMap.set(sellerIdKey, entry);
  }

  const by_seller = [...bySellerMap.values()];
  const total_spend = +by_seller.reduce((a, b) => a + toNum(b.spend || 0), 0).toFixed(2);

  await AdsDailySummary.updateOne(
    { day: dayUTC },
    { $set: { day: dayUTC, total_spend, by_seller } },
    { upsert: true }
  );

  return {
    message: "Ads imported (merged by shopId with overwrite + fallback boss)",
    day: dayUTC,
    sellersAffected: perSeller.size,
    total_spend,
    shopId: shopIdStr,
    fallbackAssignedRows: unmatchedCount,
    fallbackUserId: FALLBACK_USER_ID_RAW,
  };
};

const round2 = (v) => +toNum(v).toFixed(2);
const DAY_MS = 86400000;
function makeDayList(fromISO, toISO) {
  const from = utcDay(new Date(fromISO));
  const to = utcDay(new Date(toISO));
  const out = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) out.push(new Date(t));
  return out;
}
const isoDay = (d) => d.toISOString();

function formatDayObj(dUtcDate) {
  const d = new Date(dUtcDate);
  const convert1 = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const convert2 = `${mm}/${dd}/${yyyy}`;
  return { iso: d.toISOString(), convert1, convert2 };
}

function parseIdCsv(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

const getAdsSummary = async ({ from, to, seller }) => {
  const dayList = makeDayList(from, to);
  const fromDay = dayList[0];
  const toDay = dayList[dayList.length - 1];

  const sellerIds = parseIdCsv(seller);
  const sellerFilterSet = sellerIds.length ? new Set(sellerIds.map(String)) : null;

  const docs = await AdsDailySummary.find(
    { day: { $gte: fromDay, $lte: toDay } },
    { day: 1, total_spend: 1, by_seller: 1 }
  ).sort({ day: -1 }).lean();

  const sellerIdSet = new Set();
  const shopIdSet = new Set();
  for (const d of docs) {
    const sellers = Array.isArray(d.by_seller) ? d.by_seller : [];
    for (const s of sellers) {
      const sid = s?.seller?._id ? String(s.seller._id) : null;
      if (!sid) continue;
      if (sellerFilterSet && !sellerFilterSet.has(sid)) continue;
      sellerIdSet.add(sid);
      const shops = Array.isArray(s.by_shop) ? s.by_shop : [];
      for (const bs of shops) {
        if (bs?.shop_id) shopIdSet.add(String(bs.shop_id));
      }
    }
  }

  const users = sellerIdSet.size
    ? await User.find({ _id: { $in: [...sellerIdSet] } }, "full_name email avatar role").lean()
    : [];
  const shops = shopIdSet.size
    ? await Shop.find({ _id: { $in: [...shopIdSet] } }, "name code marketplace logo icon").lean()
    : [];
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const shopMap = new Map(shops.map((s) => [String(s._id), s]));

  const byDay = new Map(docs.map((d) => [isoDay(d.day), d]));

  let totalSpending = 0;
  const uniqSellerInRange = new Set();
  const uniqShopInRange = new Set();

  const daysPayload = dayList
    .map((day) => {
      const key = isoDay(day);
      const doc = byDay.get(key);

      if (!doc) {
        if (sellerFilterSet) return null;
        return {
          day: formatDayObj(day),
          total_spend: 0,
          seller_count: 0,
          shop_count: 0,
          by_seller: [],
        };
      }

      const allSellers = Array.isArray(doc.by_seller) ? doc.by_seller : [];
      const sellers = sellerFilterSet
        ? allSellers.filter((s) => sellerFilterSet.has(String(s?.seller?._id)))
        : allSellers;

      if (sellerFilterSet && sellers.length === 0) return null;

      const sellersOut = sellers.map((s) => {
        const sid = s?.seller?._id ? String(s.seller._id) : null;
        if (sid) uniqSellerInRange.add(sid);

        const shopsList = Array.isArray(s.by_shop) ? s.by_shop : [];
        const shopsOut = shopsList.map((bs) => {
          const shid = bs?.shop_id ? String(bs.shop_id) : null;
          if (shid) uniqShopInRange.add(shid);
          return {
            shop_id: bs?.shop_id || null,
            spend: round2(bs?.spend || 0),
            shop: shid ? shopMap.get(shid) || null : null,
          };
        });

        return {
          seller: {
            _id: s?.seller?._id || null,
            full_name: s?.seller?.full_name || "Unknown",
            user: sid ? userMap.get(sid) || null : null,
          },
          spend: round2(s?.spend || 0),
          by_shop: shopsOut,
        };
      });

      const daySpend = sellerFilterSet
        ? sellers.reduce((sum, x) => sum + toNum(x?.spend || 0), 0)
        : typeof doc.total_spend === "number" && !Number.isNaN(doc.total_spend)
          ? toNum(doc.total_spend)
          : allSellers.reduce((sum, x) => sum + toNum(x?.spend || 0), 0);

      const dayShopSet = new Set();
      for (const s of sellers) {
        for (const bs of s.by_shop || []) {
          if (bs?.shop_id) dayShopSet.add(String(bs.shop_id));
        }
      }

      totalSpending += daySpend;

      return {
        day: formatDayObj(doc.day),
        total_spend: round2(daySpend),
        seller_count: sellers.length,
        shop_count: dayShopSet.size,
        by_seller: sellersOut,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.day.iso) - new Date(a.day.iso)); // Fix sort with iso

  const summary = {
    days: daysPayload.length,
    totalSpending: round2(totalSpending),
    totalSellers: uniqSellerInRange.size,
    totalShops: uniqShopInRange.size,
  };

  return { summary, days: daysPayload };
};

module.exports = {
  importAdsForDay,
  getAdsSummary,
};

