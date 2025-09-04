// controllers/report.controller.js
const db = require("../models");
const Report = db.Report;
const User = db.user;
const OrderCustomProduct = db.orderCustomProduct;

// controllers/report.controller.js
const fs = require("fs");
const { parse } = require("csv-parse/sync");
const mongoose = require("mongoose");

// Ép số an toàn: "1,234.56" -> 1234.56, null/"" -> 0
const toNum = (v) => {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  return +s.replace(/[, ]/g, "") || 0;
};

// Chuẩn hóa keys & values (trim) vì file Amazon hay có khoảng trắng
const normalizeRow = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.trim(),
      typeof v === "string" ? v.trim() : v,
    ])
  );

// Lấy ngày dùng các cột chuẩn của Amazon
const resolveDate = (row) => {
  const raw =
    row["purchase-date"] ||
    row["payments-date"] ||
    row["order-date"] ||
    row["Purchase Date"] ||
    row["Order Date"];

  if (!raw) return null;
  const dt = new Date(raw);
  if (isNaN(dt)) return null;
  return dt;
};

// Về ngày 00:00 UTC
const utcDay = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function findSellerIdByEmployeeId(msnv) {
  if (!msnv) return null;
  // Tìm chính xác theo employee_id (không suy diễn)
  const user = await User.findOne({ employee_id: msnv }).select("_id");
  return user || null;
}
// Lấy sellerId từ SKU (tuỳ format của bạn)
const extractSellerIdFromSku = (sku) => {
  if (!sku || typeof sku !== "string") return null;
  const first = sku.split("-")[0]?.trim();
  if (!first) return null;
  // Chuẩn hoá: chữ hoa, bỏ khoảng trắng
  return first.toUpperCase();
};

// Công thức revenue bạn yêu cầu:
// revenue = item_price + shipping_price
//         - (item_tax + shipping_tax + item_promotion_discount
//            + fee(= (item_price + shipping_price)*17%))
const computeRevenue = (row) => {
  const itemPrice = toNum(row["item-price"]);
  const shipPrice = toNum(row["shipping-price"]);
  const itemTax = toNum(row["item-tax"]);
  const shipTax = toNum(row["shipping-tax"]);
  const discount = toNum(row["item-promotion-discount"]); // có thể là 0 nếu không có

  const fee = (itemPrice + shipPrice) * 0.17; // 17%
  const revenue = itemPrice + shipPrice - (itemTax + shipTax + discount + fee);

  return {
    revenue: +revenue.toFixed(2),
    fee: +fee.toFixed(2),
    tax: +(itemTax + shipTax).toFixed(2),
    ship: +shipPrice.toFixed(2),
  };
};

// POST /api/report/import-file
// body: { filePath: "/abs/path/to/file.csv" }
const importReportFromFile = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        message: "No file uploaded. Send as form-data with field 'file'.",
      });
    }

    const raw = req.file.buffer.toString("utf8");

    // Amazon .txt dùng tab
    const rows = parse(raw, {
      columns: true,
      delimiter: "\t",
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: true,
    });

    if (!rows.length) return res.json({ message: "Empty file", upserts: 0 });

    // Gom theo (sellerId, day)
    const bucket = new Map();
    const isoOf = (d) => d.toISOString();

    for (const r0 of rows) {
      const r = normalizeRow(r0);

      const sku = r["sku"];
      const skusplit = extractSellerIdFromSku(sku);
      const seller = await findSellerIdByEmployeeId(skusplit);

      if (!seller?._id) continue;

      const dt = resolveDate(r);
      if (!dt) continue;

      const day = utcDay(dt);
      const key = `${seller?._id}|${isoOf(day)}`;

      // quantity: ưu tiên 'quantity-purchased', fallback 'number-of-items', nếu không có => 1
      const qty = toNum(r["quantity"]) || 1;

      const { revenue, fee, tax, ship } = computeRevenue(r);

      if (!bucket.has(key)) {
        bucket.set(key, {
          seller: {
            _id: seller?._id,
            full_name: seller?.full_name,
          },
          day,
          items: 0,
          revenue: 0,
          fee: 0,
          opCost: 0, // tạm dùng để chứa shipping cost
          baseCost: 0,
          ads: 0,
          refund: 0,
          _tax: 0,
          _ship: 0,
        });
      }

      const agg = bucket.get(key);
      agg.items += qty;
      agg.revenue += revenue;
      agg.fee += fee;
      agg.opCost += ship; // nếu bạn muốn opCost = shipping
      agg._tax += tax;
      agg._ship += ship;
    }

    // Upsert vào Report theo (seller, day)
    let upserts = 0;
    for (const [key, v] of bucket.entries()) {
      // Lấy baseCost trực tiếp từ DB
      const baseCostAgg = await OrderCustomProduct?.aggregate([
        {
          $match: {
            sellerId: new mongoose.Types.ObjectId(v.seller?._id),
            purchase_date: {
              $gte: v.day,
              $lt: new Date(v.day.getTime() + 24 * 60 * 60 * 1000), // ngày +1
            },
          },
        },
        {
          $group: {
            _id: null,
            totalBaseCost: { $sum: "$base_cost" },
          },
        },
      ]);

      const baseCost = baseCostAgg[0]?.totalBaseCost || 0;

      // Cập nhật record Report
      const user = await User.findById(v.seller?._id);
      const update = {
        $inc: {
          items: v.items,
          revenue: +v.revenue.toFixed(2),
          fee: +v.fee.toFixed(2),
          opCost: +v.opCost.toFixed(2),
          ads: 0,
          refund: 0,
        },
        $set: {
          baseCost: +baseCost.toFixed(2), // 👈 set cứng theo DB
        },
        $setOnInsert: {
          seller: { _id: user._id, full_name: user.full_name },
          day: v.day,
        },
      };

      await Report.updateOne({ "seller._id": user._id, day: v.day }, update, {
        upsert: true,
      });
    }
    return res.json({ message: "Imported", upserts, days: bucket.size });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Import failed", error: e.message });
  }
};

function makeDayList(fromISO, toISO) {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const at00 = (d) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const days = [];
  let d = at00(from);
  const end = at00(to);
  while (d <= end) {
    days.push(new Date(d));
    d = new Date(d.getTime() + 86400000); // +1 day
  }
  return days;
}
const iso = (d) => d.toISOString();
const pad2 = (n) => String(n).padStart(2, "0");
const labelDDMM = (d) => `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}`;

// GET /api/report?from=...&to=...&seller=optional
const getReportMatrix = async (req, res) => {
  try {
    const { from, to, seller } = req.query;
    if (!from || !to)
      return res
        .status(400)
        .json({ message: "from & to are required (ISO UTC)" });

    // 1) tạo danh sách ngày để cố định thứ tự & độ dài mảng
    const dayList = makeDayList(from, to);
    const dayIndex = new Map(dayList.map((d, i) => [iso(d), i]));

    const rows = await Report.aggregate([
      { $match: { day: { $gte: new Date(from), $lte: new Date(to) } } },
      {
        $group: {
          _id: {
            sellerId: "$seller._id",
            sellerName: "$seller.full_name",
            day: "$day",
          },
          items: { $sum: "$items" },
          revenue: { $sum: "$revenue" },
          baseCost: { $sum: "$baseCost" },
          ads: { $sum: "$ads" },
          fee: { $sum: "$fee" },
          opCost: { $sum: "$opCost" },
          refund: { $sum: "$refund" },
        },
      },
      { $sort: { "_id.day": 1 } },
    ]);

    const result = {};
    const zeroArr = () => Array(dayList.length).fill(0);

    for (const r of rows) {
      const sellerName = r._id.sellerName || "Unknown";
      const idx = dayIndex.get(iso(r._id.day));
      if (idx == null) continue;

      if (!result[sellerName]) {
        result[sellerName] = {
          fee: zeroArr(),
          opCost: zeroArr(),
          refund: zeroArr(),
          items: zeroArr(),
          revenue: zeroArr(),
          baseCost: zeroArr(),
          ads: zeroArr(),
          // sẽ tính sau:
          profit1: zeroArr(),
          profit2: zeroArr(),
        };
      }
      const S = result[sellerName];
      S.items[idx] = r.items || 0;
      S.revenue[idx] = +(r.revenue || 0).toFixed(2);
      S.baseCost[idx] = +(r.baseCost || 0).toFixed(2);
      S.ads[idx] = +(r.ads || 0).toFixed(2);
      S.fee[idx] = +(r.fee || 0).toFixed(2);
      S.opCost[idx] = +(r.opCost || 0).toFixed(2);
      S.refund[idx] = +(r.refund || 0).toFixed(2);
    }

    // 4) tính profit1/profit2 cho mỗi seller theo từng ngày
    for (const sellerName of Object.keys(result)) {
      const S = result[sellerName];
      for (let i = 0; i < dayList.length; i++) {
        const profit1 = S.revenue[i] - (S.baseCost[i] + S.fee[i] + S.ads[i]);
        const profit2 = profit1 - (S.opCost[i] + S.refund[i]);
        S.profit1[i] = +profit1.toFixed(2);
        S.profit2[i] = +profit2.toFixed(2);
      }
      // nếu muốn total cho từng seller:
      const sum = (a) => +a.reduce((x, y) => x + (y || 0), 0).toFixed(2);
      result[sellerName].totals = {
        items: result[sellerName].items.reduce((x, y) => x + (y || 0), 0),
        revenue: sum(result[sellerName].revenue),
        baseCost: sum(result[sellerName].baseCost),
        ads: sum(result[sellerName].ads),
        fee: sum(result[sellerName].fee),
        opCost: sum(result[sellerName].opCost),
        refund: sum(result[sellerName].refund),
        profit1: sum(result[sellerName].profit1),
        profit2: sum(result[sellerName].profit2),
      };
    }

    const dates = dayList.map(labelDDMM);

    // Trả về đúng format bạn mong muốn (không cần mảng days nếu không dùng)
    return res.json({ date: dates, data: result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Get report failed" });
  }
};

module.exports = { importReportFromFile, getReportMatrix };
