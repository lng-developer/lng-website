// controllers/ads.controller.js
const { parse } = require("csv-parse/sync");
const db = require("../models");
const User = db.user;
const AdsDailySummary = db.Ads;
const mongoose = require("mongoose");
const { Types } = mongoose; // dùng để cast shopId -> ObjectId

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

    // Cast shopId -> ObjectId (nếu không cast được vẫn lưu string để không vỡ import)
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

    // ===== Map SKU -> Seller =====
    const allSkus = rows.map((r) => r.Campaigns).filter(Boolean);
    const sellerMap = await mapSellersBySku(allSkus);

    // ===== Tính spend theo seller cho SHOP hiện tại =====
    // perSeller: sellerId -> { seller: {_id, full_name}, spend }
    const perSeller = new Map();
    for (const r of rows) {
      const sku = r.Campaigns;
      if (!sku) continue;
      const seller = sellerMap.getBySku(sku);
      if (!seller?._id) continue;

      const spend = toNum(r.Spend);
      const key = String(seller._id);
      if (!perSeller.has(key)) {
        perSeller.set(key, {
          seller: { _id: seller._id, full_name: seller.full_name || "Unknown" },
          spend: 0,
        });
      }
      perSeller.get(key).spend += spend;
    }

    if (!perSeller.size) {
      return res.json({
        message: "No matched sellers from SKUs in file.",
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
                shop_id: x.shop_id, // giữ nguyên kiểu (ObjectId hoặc string)
                spend: toNum(x.spend) || 0,
              }))
            : [],
        });
      }
    }

    // ===== Merge theo SHOP =====
    for (const { seller, spend } of perSeller.values()) {
      const sellerId = String(seller._id);
      if (!bySellerMap.has(sellerId)) {
        bySellerMap.set(sellerId, { seller, spend: 0, by_shop: [] });
      }

      const entry = bySellerMap.get(sellerId);

      // Tìm shop trùng để GHI ĐÈ
      const idx = entry.by_shop.findIndex(
        (x) => String(x.shop_id) === shopIdStr
      );
      if (idx >= 0) {
        entry.by_shop[idx].spend = +spend.toFixed(2); // ghi đè shop hiện tại
      } else {
        // Thêm shop mới (KHÁC shop)
        entry.by_shop.push({
          shop_id: shopIdObj,
          spend: +spend.toFixed(2),
        });
      }

      // Recompute tổng spend của seller
      entry.spend = +entry.by_shop
        .reduce((a, b) => a + toNum(b.spend || 0), 0)
        .toFixed(2);
      bySellerMap.set(sellerId, entry);
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
      message: "Ads imported (merged by shopId)",
      day: dayUTC,
      sellersAffected: perSeller.size,
      total_spend,
      shopId: shopIdStr,
    });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ message: "Import ads failed", error: e.message });
  }
};

module.exports = { importAdsForDay };
