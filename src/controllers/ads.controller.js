// controllers/ads.controller.js
const { parse } = require("csv-parse/sync");
const db = require("../models");
const User = db.user;
const AdsDailySummary = db.Ads;

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

/**
 * POST /api/ads/import-day?mode=replace|append
 * form-data:
 *   - day: ISO hoặc yyyy-MM-dd (bắt buộc) -> sẽ lưu về 00:00 UTC
 *   - file: CSV/TXT (bắt buộc) | cột: sku, spend (alias: SKU/Sku, Spend/cost/Cost)
 */
const importAdsForDay = async (req, res) => {
  try {
    if (!req.file?.buffer)
      return res.status(400).json({ message: "Send form-data 'file'." });
    const { day, mode = "replace" } = req.body;
    if (!day)
      return res.status(400).json({ message: "form-data 'day' is required." });

    const dayUTC = utcDay(new Date(day));
    if (isNaN(dayUTC))
      return res.status(400).json({ message: "Invalid day format" });

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

    // Chuẩn bị map seller
    const allSkus = rows.map((r) => r.Campaigns).filter(Boolean);
    const sellerMap = await mapSellersBySku(allSkus);

    // Gom theo seller
    const perSeller = new Map(); // sellerId -> { seller, spend }
    for (const r of rows) {
      const sku = r.Campaigns;
      const spend = toNum(r.Spend);
      if (!sku) continue;
      const seller = sellerMap.getBySku(sku);
      if (!seller?._id) continue;

      const key = String(seller._id);
      if (!perSeller.has(key)) perSeller.set(key, { seller, spend: 0 });
      perSeller.get(key).spend += spend;
    }

    // Load summary ngày (nếu có)
    const existed = await AdsDailySummary.findOne({ day: dayUTC }).lean();

    // Merge theo mode
    const bySellerMap = new Map();
    if (existed?.by_seller?.length) {
      for (const s of existed.by_seller) {
        bySellerMap.set(String(s.seller._id), {
          seller: s.seller,
          spend: toNum(s.spend),
        });
      }
    }
    for (const { seller, spend } of perSeller.values()) {
      const id = String(seller._id);
      const rounded = +spend.toFixed(2);
      if (mode === "append" && bySellerMap.has(id)) {
        bySellerMap.get(id).spend = +(
          bySellerMap.get(id).spend + rounded
        ).toFixed(2);
      } else {
        bySellerMap.set(id, {
          seller: { _id: seller._id, full_name: seller.full_name || "Unknown" },
          spend: rounded,
        });
      }
    }

    const by_seller = [...bySellerMap.values()];
    const total_spend =
      mode === "append"
        ? +(
            (existed?.total_spend || 0) +
            [...perSeller.values()].reduce((a, b) => a + b.spend, 0)
          ).toFixed(2)
        : +by_seller.reduce((a, b) => a + toNum(b.spend), 0).toFixed(2);

    // Ghi summary (idempotent với replace)
    await AdsDailySummary.updateOne(
      { day: dayUTC },
      { $set: { day: dayUTC, total_spend, by_seller } },
      { upsert: true }
    );

    return res.json({
      message: "Ads imported for given day (summary only)",
      day: dayUTC,
      sellers: perSeller.size,
      totalSpend: total_spend,
      mode,
    });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ message: "Import ads failed", error: e.message });
  }
};

module.exports = { importAdsForDay };
