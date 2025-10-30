// controllers/ads.controller.js
const { parse } = require("csv-parse/sync");
const db = require("../models");
const User = db.user;
const AdsDailySummary = db.Ads;
const Shop = db.shop;
const mongoose = require("mongoose");
const { Types } = mongoose; // dùng để cast shopId -> ObjectId
const InprocQueue = require("../lib/inprocQueue");
const importQueue = new InprocQueue({
  concurrency: Number(process.env.ADS_IMPORT_CONCURRENCY || 1),
});
const logbus = require("../lib/logbus");
const fs = require("fs");

// ép số
const toNum = (v) => {
  if (typeof v === "number") return v;
  if (v == null) return 0;

  const s = String(v).trim();
  if (!s) return 0;

  // loại bỏ $, , và khoảng trắng
  const cleaned = s.replace(/[\$, ]/g, "");

  const n = +cleaned;
  return Number.isFinite(n) ? n : 0;
};
// chuẩn hoá key/value
const norm = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.trim(),
      typeof v === "string" ? v.trim() : v,
    ])
  );

// phát hiện delimiter: tab hoặc phẩy
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find(Boolean) || "";
  return firstLine.includes("\t") ? "\t" : ",";
}

// chốt 00:00 UTC
const utcDay = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// Map nhiều SKU → user 1 lần
async function mapSellersBySku(skus) {
  const codes = [
    ...new Set(
      skus
        .map((s) =>
          typeof s === "string" ? s.split("-")[0]?.trim().toUpperCase() : ""
        )
        .filter(Boolean)
    ),
  ];
  if (!codes.length) return { getBySku: () => null };

  const users = await User.find({ employee_id: { $in: codes } })
    .select("_id full_name employee_id")
    .lean();

  const byCode = new Map(
    users.map((u) => [String(u.employee_id).toUpperCase(), u])
  );
  return {
    getBySku(sku) {
      if (!sku || typeof sku !== "string") return null;
      const code = sku.split("-")[0]?.trim().toUpperCase();
      if (!code) return null;
      return byCode.get(code) || null;
    },
  };
}

// ... các import/helper khác như cũ (utcDay, detectDelimiter, norm, toNum, mapSellersBySku, AdsDailySummary)

const FALLBACK_USER_ID_RAW = "68b93ed3f02eed8dec002ee3";
const FALLBACK_USER_ID = Types.ObjectId.isValid(FALLBACK_USER_ID_RAW)
  ? new Types.ObjectId(FALLBACK_USER_ID_RAW)
  : FALLBACK_USER_ID_RAW;
const FALLBACK_USER_NAME = "Boss (Unattributed Ads)";

const importAdsForDay = async (req, res) => {
  try {
    // ===== Validate =====
    if (!req.file?.buffer)
      return res.status(400).json({ message: "Send form-data 'file'." });

    const { day, shopId } = req.body;
    if (!day)
      return res.status(400).json({ message: "form-data 'day' is required." });
    if (!shopId)
      return res
        .status(400)
        .json({ message: "form-data 'shopId' is required." });

    const dayUTC = utcDay(new Date(day));
    if (isNaN(dayUTC))
      return res.status(400).json({ message: "Invalid day format" });

    // Cast shopId -> ObjectId (nếu không cast được vẫn lưu string)
    const shopIdObj = Types.ObjectId.isValid(shopId)
      ? new Types.ObjectId(shopId)
      : shopId;
    const shopIdStr = String(shopId);

    // ===== Parse CSV =====
    const raw = req.file.buffer.toString("utf8");
    const delimiter = detectDelimiter(raw);
    const rows = parse(raw, {
      columns: true,
      delimiter,
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: true,
    }).map(norm);
    if (!rows.length) return res.json({ message: "Empty file", upserts: 0 });

    // ===== Map SKU -> Seller (ở đây bạn đang dùng cột Campaigns như "SKU/Key")=====
    const allSkusOrNames = rows.map((r) => r.Campaigns).filter(Boolean);
    const sellerMap = await mapSellersBySku(allSkusOrNames);

    // ===== Tính spend theo seller cho SHOP hiện tại (thêm fallback) =====
    // perSeller: sellerId -> { seller: {_id, full_name}, spend }
    const perSeller = new Map();
    let unmatchedCount = 0;

    for (const r of rows) {
      const campName = (r.Campaigns || "").trim();
      if (!campName) continue;

      // Thử map theo “SKU/Key” bạn đang dùng
      const mappedSeller = sellerMap.getBySku(campName);
      let sellerId, sellerName;

      if (mappedSeller?._id) {
        sellerId = String(mappedSeller._id);
        sellerName = mappedSeller.full_name || "Unknown";
      } else {
        // Không map được -> kiểm tra có phải campaign generic không (không bắt buộc)
        // Dù có match hay không, yêu cầu của bạn là "không lọc được ra seller" -> gán fallback
        sellerId = String(FALLBACK_USER_ID);
        sellerName = FALLBACK_USER_NAME;
        unmatchedCount++;
      }

      const spend = toNum(r.Spend);
      if (!perSeller.has(sellerId)) {
        perSeller.set(sellerId, {
          seller: {
            _id: Types.ObjectId.isValid(sellerId)
              ? new Types.ObjectId(sellerId)
              : sellerId,
            full_name: sellerName,
          },
          spend: 0,
        });
      }
      perSeller.get(sellerId).spend += spend;
    }

    if (!perSeller.size) {
      return res.json({
        message: "No matched rows.",
        day: dayUTC,
        sellers: 0,
        totalSpendDelta: 0,
        shopId: shopIdStr,
      });
    }

    // Làm tròn 2 số
    for (const v of perSeller.values()) v.spend = +v.spend.toFixed(2);

    // ===== Lấy summary ngày (nếu có) =====
    const existed = await AdsDailySummary.findOne({ day: dayUTC }).lean();

    // ===== Build map hiện trạng =====
    // bySellerMap: sellerId -> { seller, spend, by_shop: [{shop_id, spend}] }
    const bySellerMap = new Map();
    if (existed?.by_seller?.length) {
      for (const s of existed.by_seller) {
        bySellerMap.set(String(s.seller._id), {
          seller: s.seller,
          spend: toNum(s.spend) || 0,
          by_shop: Array.isArray(s.by_shop)
            ? s.by_shop.map((x) => ({
                shop_id: x.shop_id,
                spend: toNum(x.spend) || 0,
              }))
            : [],
        });
      }
    }

    // ===== Reset toàn bộ spend của SHOP này trước khi merge (idempotent theo (day, shopId)) =====
    for (const [sid, entry] of bySellerMap.entries()) {
      if (Array.isArray(entry.by_shop) && entry.by_shop.length) {
        entry.by_shop = entry.by_shop.filter(
          (bs) => String(bs.shop_id) !== shopIdStr
        );
        entry.spend = +entry.by_shop
          .reduce((a, b) => a + toNum(b.spend || 0), 0)
          .toFixed(2);
        bySellerMap.set(sid, entry);
      }
    }

    // ===== Merge theo SHOP (ghi đè shop hiện tại bằng số mới) =====
    for (const { seller, spend } of perSeller.values()) {
      const sellerIdKey = String(seller._id);
      if (!bySellerMap.has(sellerIdKey)) {
        bySellerMap.set(sellerIdKey, { seller, spend: 0, by_shop: [] });
      }

      const entry = bySellerMap.get(sellerIdKey);

      // Sau reset, shop hiện tại không còn -> push mới
      entry.by_shop.push({
        shop_id: shopIdObj,
        spend: +spend.toFixed(2),
      });

      // Recompute tổng spend của seller
      entry.spend = +entry.by_shop
        .reduce((a, b) => a + toNum(b.spend || 0), 0)
        .toFixed(2);

      bySellerMap.set(sellerIdKey, entry);
    }

    // ===== Tổng hệ thống =====
    const by_seller = [...bySellerMap.values()];
    const total_spend = +by_seller
      .reduce((a, b) => a + toNum(b.spend || 0), 0)
      .toFixed(2);

    // ===== Upsert summary ngày (idempotent theo shopId) =====
    await AdsDailySummary.updateOne(
      { day: dayUTC },
      { $set: { day: dayUTC, total_spend, by_seller } },
      { upsert: true }
    );

    return res.json({
      message: "Ads imported (merged by shopId with overwrite + fallback boss)",
      day: dayUTC,
      sellersAffected: perSeller.size,
      total_spend,
      shopId: shopIdStr,
      fallbackAssignedRows: unmatchedCount, // cho bạn biết có bao nhiêu dòng gán về boss
      fallbackUserId: FALLBACK_USER_ID_RAW,
    });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ message: "Import ads failed", error: e.message });
  }
};

async function importAdsForDayProcessor({
  buffer,
  filePath,
  body = {},
  onLog = () => {},
}) {
  if (!buffer && !filePath) {
    throw new Error("Send form-data 'file'.");
  }

  const raw = buffer?.toString("utf8") || fs.readFileSync(filePath, "utf8");

  const { day, shopId } = body;
  if (!day) throw new Error("form-data 'day' is required.");
  if (!shopId) throw new Error("form-data 'shopId' is required.");

  const dayUTC = utcDay(new Date(day));
  if (isNaN(dayUTC)) throw new Error("Invalid day format");

  const shopIdObj = Types.ObjectId.isValid(shopId)
    ? new Types.ObjectId(shopId)
    : shopId;
  const shopIdStr = String(shopId);

  // Parse
  const delimiter = detectDelimiter(raw);
  const rows = parse(raw, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: true,
  }).map(norm);

  onLog({ type: "step", message: `parsed ${rows.length} rows` });
  if (!rows.length) {
    return {
      message: "Empty file",
      upserts: 0,
      day: dayUTC,
      shopId: shopIdStr,
    };
  }

  // Map seller theo Campaigns (SKU/key của bạn)
  const allSkusOrNames = rows.map((r) => r.Campaigns).filter(Boolean);
  const sellerMap = await mapSellersBySku(allSkusOrNames);

  // Tổng hợp spend theo seller cho SHOP hiện tại
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
          _id: Types.ObjectId.isValid(sellerId)
            ? new Types.ObjectId(sellerId)
            : sellerId,
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
      sellersAffected: 0,
      total_spend: 0,
      shopId: shopIdStr,
    };
  }

  // Làm tròn
  for (const v of perSeller.values()) v.spend = +v.spend.toFixed(2);

  // Lấy summary ngày (nếu có)
  const existed = await AdsDailySummary.findOne({ day: dayUTC }).lean();

  // Build map hiện trạng
  const bySellerMap = new Map();
  if (existed?.by_seller?.length) {
    for (const s of existed.by_seller) {
      bySellerMap.set(String(s.seller._id), {
        seller: s.seller,
        spend: toNum(s.spend) || 0,
        by_shop: Array.isArray(s.by_shop)
          ? s.by_shop.map((x) => ({
              shop_id: x.shop_id,
              spend: toNum(x.spend) || 0,
            }))
          : [],
      });
    }
  }

  // Reset dữ liệu SHOP hiện tại trước khi merge (idempotent theo (day, shopId))
  for (const [sid, entry] of bySellerMap.entries()) {
    if (Array.isArray(entry.by_shop) && entry.by_shop.length) {
      entry.by_shop = entry.by_shop.filter(
        (bs) => String(bs.shop_id) !== shopIdStr
      );
      entry.spend = +entry.by_shop
        .reduce((a, b) => a + toNum(b.spend || 0), 0)
        .toFixed(2);
      bySellerMap.set(sid, entry);
    }
  }

  // Merge kết quả mới cho SHOP hiện tại
  for (const { seller, spend } of perSeller.values()) {
    const sellerIdKey = String(seller._id);
    if (!bySellerMap.has(sellerIdKey)) {
      bySellerMap.set(sellerIdKey, { seller, spend: 0, by_shop: [] });
    }

    const entry = bySellerMap.get(sellerIdKey);
    entry.by_shop.push({ shop_id: shopIdObj, spend: +spend.toFixed(2) });
    entry.spend = +entry.by_shop
      .reduce((a, b) => a + toNum(b.spend || 0), 0)
      .toFixed(2);
    bySellerMap.set(sellerIdKey, entry);
  }

  const by_seller = [...bySellerMap.values()];
  const total_spend = +by_seller
    .reduce((a, b) => a + toNum(b.spend || 0), 0)
    .toFixed(2);

  // Upsert summary ngày (idempotent)
  await AdsDailySummary.updateOne(
    { day: dayUTC },
    { $set: { day: dayUTC, total_spend, by_seller } },
    { upsert: true }
  );

  onLog({
    type: "done",
    message: "ads spend imported",
    meta: { sellers: perSeller.size, total_spend },
  });

  return {
    message: "Ads imported (merged by shopId with overwrite + fallback boss)",
    day: dayUTC,
    sellersAffected: perSeller.size,
    total_spend,
    shopId: shopIdStr,
    fallbackAssignedRows: unmatchedCount,
    fallbackUserId: FALLBACK_USER_ID_RAW,
  };
}

// -----------------------------------------------------------
// 2) ENQUEUE HANDLER — POST /ads/import-day
//    Trả 202 ngay; job chạy nền + bắn realtime log
// -----------------------------------------------------------
async function importAdsForDayEnqueue(req, res) {
  try {
    if (!req.file?.buffer && !req.file?.path) {
      return res
        .status(400)
        .json({ ok: false, message: "Send form-data 'file'." });
    }

    const io = req.app.get("io");
    const shopId = req.body?.shopId || null;
    const machineId = req.body?.machineId || null;

    const buffer = req.file.buffer || null;
    const filePath = req.file.path || null;

    const jobId = importQueue.enqueue(
      "import-ads",
      { hasFile: !!(buffer || filePath) },
      async (job) => {
        const onLog = (ev) => {
          const event = {
            at: Date.now(),
            jobId: job.id,
            shopId,
            machineId,
            type: ev.type || "info", // info|step|done|error|warn
            message: ev.message || "",
            meta: ev.meta || undefined,
          };
          if (io) {
            io.emit("realtime:log", event);
            if (shopId) io.to(`shop:${shopId}`).emit("realtime:log", event);
          }
          logbus.append(event);
        };

        try {
          onLog({ type: "step", message: "ads processor:start" });
          const result = await importAdsForDayProcessor({
            buffer,
            filePath,
            body: req.body,
            onLog,
          });
          onLog({
            type: "done",
            message: "ads processor:finished",
            meta: { result },
          });
        } catch (e) {
          onLog({
            type: "error",
            message: `ads processor:failed - ${e.message}`,
          });
        }
      }
    );

    return res.status(202).json({ ok: true, jobId, queued: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

const round2 = (v) => +toNum(v).toFixed(2);
const DAY_MS = 86400000;
// sinh list ngày [from..to], gồm cả 2 đầu, ở 00:00 UTC
function makeDayList(fromISO, toISO) {
  const from = utcDay(new Date(fromISO));
  const to = utcDay(new Date(toISO));
  const out = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS)
    out.push(new Date(t));
  return out;
}
const isoDay = (d) => d.toISOString(); // 00:00 UTC -> chuỗi ISO

// Helpers thêm vào phía trên file
function formatDayObj(dUtcDate) {
  const d = new Date(dUtcDate); // đảm bảo là Date
  const convert1 = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(d);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const convert2 = `${mm}/${dd}/${yyyy}`;
  return { iso: d.toISOString(), convert1, convert2 };
}

// helper nhỏ để parse ?seller=id1,id2
function parseIdCsv(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getAdsSummary(req, res) {
  try {
    const { from, to, seller } = req.query; // <-- lấy thêm seller
    if (!from || !to) {
      return res
        .status(400)
        .json({ message: "Query 'from' & 'to' are required (ISO UTC)" });
    }

    // ===== 1) Chuẩn bị dải ngày (GIỮ NGUYÊN) =====
    const dayList = makeDayList(from, to);
    const fromDay = dayList[0];
    const toDay = dayList[dayList.length - 1];

    // ===== 1.1) Chuẩn bị set lọc seller (nếu có) =====
    const sellerIds = parseIdCsv(seller);
    const sellerFilterSet = sellerIds.length
      ? new Set(sellerIds.map(String))
      : null;

    // ===== 2) Lấy AdsDailySummary trong khoảng (GIỮ NGUYÊN) =====
    const docs = await AdsDailySummary.find(
      { day: { $gte: fromDay, $lte: toDay } },
      { day: 1, total_spend: 1, by_seller: 1 }
    )
      .sort({ day: -1 })
      .lean();

    // ===== 3) Gom ID cần populate (đã áp lọc seller nếu có) =====
    const sellerIdSet = new Set();
    const shopIdSet = new Set();
    for (const d of docs) {
      const sellers = Array.isArray(d.by_seller) ? d.by_seller : [];
      for (const s of sellers) {
        const sid = s?.seller?._id ? String(s.seller._id) : null;
        if (!sid) continue;
        if (sellerFilterSet && !sellerFilterSet.has(sid)) continue; // chỉ gom id theo filter
        sellerIdSet.add(sid);
        const shops = Array.isArray(s.by_shop) ? s.by_shop : [];
        for (const bs of shops) {
          if (bs?.shop_id) shopIdSet.add(String(bs.shop_id));
        }
      }
    }

    // ===== 4) “Populate” thủ công user & shop (GIỮ NGUYÊN) =====
    const users = sellerIdSet.size
      ? await User.find(
          { _id: { $in: [...sellerIdSet] } },
          "full_name email avatar role"
        ).lean()
      : [];
    const shops = shopIdSet.size
      ? await Shop.find(
          { _id: { $in: [...shopIdSet] } },
          "name code marketplace logo icon"
        ).lean()
      : [];
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const shopMap = new Map(shops.map((s) => [String(s._id), s]));

    // ===== 5) Map day -> doc để fill đủ ngày (GIỮ NGUYÊN) =====
    const byDay = new Map(docs.map((d) => [isoDay(d.day), d]));

    // Biến tổng cho summary (GIỮ NGUYÊN)
    let totalSpending = 0;
    const uniqSellerInRange = new Set();
    const uniqShopInRange = new Set();

    // ===== 6) Build mảng days (áp lọc seller + giữ nguyên mọi thứ khác) =====
    const daysPayload = dayList
      .map((day) => {
        const key = isoDay(day);
        const doc = byDay.get(key);

        if (!doc) {
          // Nếu có lọc seller thì bỏ ngày không có dữ liệu của seller đó
          if (sellerFilterSet) return null;
          return {
            day: formatDayObj(day),
            total_spend: 0,
            seller_count: 0,
            shop_count: 0,
            by_seller: [],
          };
        }

        // LỌC SELLER CHO NGÀY NÀY (phần thêm mới)
        const allSellers = Array.isArray(doc.by_seller) ? doc.by_seller : [];
        const sellers = sellerFilterSet
          ? allSellers.filter((s) =>
              sellerFilterSet.has(String(s?.seller?._id))
            )
          : allSellers;

        // Nếu có filter và ngày này không có seller chỉ định -> bỏ ngày
        if (sellerFilterSet && sellers.length === 0) return null;

        // Chuẩn hoá + populate (GIỮ NGUYÊN)
        const sellersOut = sellers.map((s) => {
          const sid = s?.seller?._id ? String(s.seller._id) : null;
          if (sid) uniqSellerInRange.add(sid);

          const shops = Array.isArray(s.by_shop) ? s.by_shop : [];
          const shopsOut = shops.map((bs) => {
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

        // Tổng theo ngày:
        // - Nếu có filter -> tổng từ các seller đã lọc
        // - Nếu không filter -> dùng total_spend hoặc sum sellers như cũ
        const daySpend = sellerFilterSet
          ? sellers.reduce((sum, x) => sum + toNum(x?.spend || 0), 0)
          : typeof doc.total_spend === "number" &&
            !Number.isNaN(doc.total_spend)
          ? toNum(doc.total_spend)
          : allSellers.reduce((sum, x) => sum + toNum(x?.spend || 0), 0);

        // Đếm shop trong ngày dựa trên sellers đã lọc
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
      .filter(Boolean) // loại các ngày không có seller theo filter
      // giữ nguyên sort của bạn
      .sort((a, b) => new Date(b.day) - new Date(a.day));

    // ===== 7) Summary (GIỮ NGUYÊN) =====
    const summary = {
      days: daysPayload.length,
      totalSpending: round2(totalSpending),
      totalSellers: uniqSellerInRange.size,
      totalShops: uniqShopInRange.size,
    };

    return res.json({ summary, days: daysPayload });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ message: "Get ads summary failed", error: e.message });
  }
}

module.exports = {
  importAdsForDay,
  getAdsSummary,
  importAdsForDayProcessor,
  importAdsForDayEnqueue,
};
