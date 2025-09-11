// controllers/report.controller.js
const db = require("../models");
const OrderCustomProduct = db.orderCustomProduct;
const AdsDailySummary = db.Ads;
const { parse } = require("csv-parse/sync");
const mongoose = require("mongoose");

// ép số an toàn
const num = (v) => {
  if (v == null) return 0;
  const n = +String(v).trim().replace(/[, ]/g, "");
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

// POST /api/report/import-file
// body: { filePath: "/abs/path/to/file.csv" }
const importReportFromFile = async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: "Send form-data 'file' (txt)" });
    }

    const raw = req.file.buffer.toString("utf8");
    const rows = parse(raw, {
      columns: true,
      delimiter: "\t",
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: true,
      // Nếu file có các ô chứa JSON: có thể cân nhắc thêm:
      // quote: false, relax_quotes: true
    }).map(norm);

    // Gom theo orderId
    const bucket = new Map();

    for (const r of rows) {
      const orderId = r["amazon-order-id"];
      if (!orderId) continue;

      // qty chỉ để tham khảo (KHÔNG nhân vào tiền)
      const qty = num(r["quantity"]) || 0;

      const itemPrice = num(r["item-price"]);
      const itemTax = num(r["item-tax"]);
      const shippingPrice = num(r["shipping-price"]);
      const shippingTax = num(r["shipping-tax"]);
      const discount = num(r["item-promotion-discount"]);

      // Tính fee & revenue theo mỗi dòng (đã là tổng theo qty từ Amazon)
      const fee = 0.17 * (itemPrice + shippingPrice);
      const revenue =
        itemPrice + shippingPrice - (itemTax + shippingTax + discount + fee);

      const acc = bucket.get(orderId) || {
        orderId,
        quantity: 0,
        item_price: 0,
        item_tax: 0,
        shipping_price: 0,
        shipping_tax: 0,
        item_promotion_discount: 0,
        fee: 0,
        revenue: 0,
        purchase_date_raw: r["purchase-date"], // giữ để set nếu order chưa có
      };

      acc.quantity += qty;
      acc.item_price += itemPrice;
      acc.item_tax += itemTax;
      acc.shipping_price += shippingPrice;
      acc.shipping_tax += shippingTax;
      acc.item_promotion_discount += discount;
      acc.fee += fee;
      acc.revenue += revenue;

      bucket.set(orderId, acc);
    }

    // Bulk updates (2 bước)
    const ops = [];

    for (const acc of bucket.values()) {
      const amazon_finance_total = {
        item_price: +acc.item_price.toFixed(2),
        item_tax: +acc.item_tax.toFixed(2),
        shipping_price: +acc.shipping_price.toFixed(2),
        shipping_tax: +acc.shipping_tax.toFixed(2),
        item_promotion_discount: +acc.item_promotion_discount.toFixed(2),
        fee: +acc.fee.toFixed(2),
        revenue: +acc.revenue.toFixed(2),
        computed_at: new Date(),
      };

      // (A) Luôn ghi đè amazon_finance_total & amazon_total_quantity
      ops.push({
        updateOne: {
          filter: { orderId: acc.orderId }, // ❗️chỉ đơn đã có
          update: {
            $set: {
              amazon_finance_total,
              amazon_total_quantity: acc.quantity,
            },
            $currentDate: { updatedAt: true }, // nếu schema có timestamps
          },
          upsert: false, // ❗️không tạo mới
        },
      });

      // (B) CHỈ set purchase_date nếu order CHƯA có
      if (acc.purchase_date_raw) {
        const d = new Date(acc.purchase_date_raw);
        if (!isNaN(d)) {
          ops.push({
            updateOne: {
              filter: {
                orderId: acc.orderId,
                $or: [
                  { purchase_date: { $exists: false } },
                  { purchase_date: null },
                ],
              },
              update: { $set: { purchase_date: d } },
              upsert: false,
            },
          });
        }
      }
    }

    let bulkResult = null;
    if (ops.length) {
      bulkResult = await OrderCustomProduct.bulkWrite(ops, { ordered: false });
    }

    res.json({
      message:
        "Imported: overwrite amazon_finance_total only; purchase_date set-if-missing",
      ordersParsed: bucket.size,
      opsCount: ops.length,
      bulkResult,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Import failed", error: err.message });
  }
};

// helpers
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

// GET /api/report?from=...&to=...&seller=optional (seller có thể là 1 id hoặc nhiều id, ngăn bởi dấu phẩy)
// YÊU CẦU: đã import đủ các model & lib
// const mongoose = require('mongoose');
// const OrderCustomProduct = db.orderCustomProduct;
// const AdsDailySummary = db.AdsDailySummary;

const getReportMatrix = async (req, res) => {
  try {
    const { from, to, seller, userNull } = req.query;
    if (!from || !to) {
      return res
        .status(400)
        .json({ message: "from & to are required (ISO UTC)" });
    }

    // ===== 0) Quyền hạn =====
    const role = req.user?.role || "";
    const userId = req.user?.userId || "";
    const isAdmin = /^admin$/i.test(role);
    const isSeller = /^seller$/i.test(role);

    if (!isAdmin && !isSeller) {
      return res
        .status(403)
        .json({ message: "Access denied: insufficient permissions" });
    }
    if (isSeller && !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user id in token" });
    }

    // ===== 1) chuẩn bị date list =====
    const dayList = makeDayList(from, to);
    const dayIndex = new Map(dayList.map((d, i) => [iso(d), i]));
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // ===== 2) Build match theo quyền & query =====
    // Chỉ lấy đơn đã có object amazon_finance_total (đã import finance)
    const matchStage = {
      purchase_date: { $gte: fromDate, $lte: toDate },
      amazon_finance_total: { $exists: true, $ne: null },
    };

    // - Seller: chỉ cho xem dữ liệu của chính mình
    // - Admin: có thể lọc theo 1 hay nhiều sellerId qua ?seller=id1,id2,...
    let sellerIdSet = null; // dùng để lọc dữ liệu ads
    if (isSeller) {
      matchStage.sellerId = new mongoose.Types.ObjectId(userId);
      sellerIdSet = new Set([String(userId)]);
    } else {
      if (seller) {
        const ids = seller
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((id) => new mongoose.Types.ObjectId(id));
        if (ids.length === 1) matchStage.sellerId = ids[0];
        else if (ids.length > 1) matchStage.sellerId = { $in: ids };
        sellerIdSet = new Set(ids.map(String));
      }
      // Admin có thể xin cả đơn chưa gán seller (tùy bạn cho phép):
      if (userNull === "true") {
        if (matchStage.sellerId) {
          if (matchStage.sellerId.$in) {
            matchStage.sellerId.$in.push(null, undefined);
          } else {
            matchStage.sellerId = {
              $in: [matchStage.sellerId, null, undefined],
            };
          }
        } else {
          matchStage.sellerId = { $in: [null, undefined] };
        }
      }
    }

    // ===== 3) Aggregation đơn hàng (chỉ các đơn có amazon_finance_total) =====
    const rows = await OrderCustomProduct.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from: "users",
          localField: "sellerId",
          foreignField: "_id",
          as: "seller",
        },
      },
      {
        $addFields: {
          sellerName: { $ifNull: [{ $first: "$seller.full_name" }, "Unknown"] },
        },
      },
      {
        $addFields: {
          day: {
            $dateTrunc: {
              date: "$purchase_date",
              unit: "day",
              timezone: "UTC",
            },
          },
        },
      },
      {
        $group: {
          _id: {
            sellerId: "$sellerId",
            sellerName: "$sellerName",
            day: "$day",
          },
          // items = số order (đã có revenue) trong ngày
          items: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$amazon_finance_total.revenue", 0] } },
          fee: { $sum: { $ifNull: ["$amazon_finance_total.fee", 0] } },
          baseCost: { $sum: { $ifNull: ["$base_cost", 0] } },
          ads: { $sum: { $ifNull: ["$ads", 0] } }, // nếu bạn có lưu ads trên order
          opCost: { $sum: { $ifNull: ["$op_cost", 0] } }, // chi phí vận hành nếu có
          refund: { $sum: { $ifNull: ["$refund", 0] } },
        },
      },
      { $sort: { "_id.day": 1 } },
    ]);

    // ===== 4) Lấy dữ liệu ADS từ AdsDailySummary =====
    // (nếu truyền sellerIdSet thì lọc theo; nếu không thì lấy tất cả trong khoảng ngày)
    const adsDocs = await AdsDailySummary.find(
      { day: { $gte: dayList[0], $lte: dayList[dayList.length - 1] } },
      { day: 1, by_seller: 1 }
    ).lean();

    const adsMap = new Map(); // key = `${sellerId}|${iso(day)}`
    for (const doc of adsDocs) {
      const dayIso = iso(doc.day);
      for (const row of doc.by_seller || []) {
        const sid = row?.seller?._id;
        if (!sid) continue;
        if (sellerIdSet && !sellerIdSet.has(String(sid))) continue; // tôn trọng filter seller
        const key = `${String(sid)}|${dayIso}`;
        adsMap.set(key, {
          spend: Number(row.spend || 0),
          sellerName: row.seller.full_name || "Unknown",
        });
      }
    }

    // ===== 5) Gộp kết quả đơn hàng theo sellerName/ngày =====
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
          profit1: zeroArr(),
          profit2: zeroArr(),
        };
      }

      const S = result[sellerName];
      S.items[idx] = r.items || 0;
      S.revenue[idx] = +(r.revenue || 0).toFixed(2);
      S.baseCost[idx] = +(r.baseCost || 0).toFixed(2);
      S.fee[idx] = +(r.fee || 0).toFixed(2);
      S.opCost[idx] = +(r.opCost || 0).toFixed(2);
      S.refund[idx] = +(r.refund || 0).toFixed(2);
      // ads từ order (nếu có) — sẽ bị ADS Summary ghi đè ở bước 6
      S.ads[idx] = +(r.ads || 0).toFixed(2);
    }

    // ===== 6) Ghi đè ADS từ AdsDailySummary (nguồn “chuẩn”) =====
    for (const [key, val] of adsMap.entries()) {
      const [_, dayIso] = key.split("|");
      const idx = dayIndex.get(dayIso);
      if (idx == null) continue;

      const sellerName = val.sellerName || "Unknown";
      if (!result[sellerName]) {
        result[sellerName] = {
          fee: zeroArr(),
          opCost: zeroArr(),
          refund: zeroArr(),
          items: zeroArr(),
          revenue: zeroArr(),
          baseCost: zeroArr(),
          ads: zeroArr(),
          profit1: zeroArr(),
          profit2: zeroArr(),
        };
      }
      result[sellerName].ads[idx] = +(val.spend || 0).toFixed(2);
    }

    // ===== 7) Tính profit1/profit2 + totals =====
    for (const sellerName of Object.keys(result)) {
      const S = result[sellerName];
      for (let i = 0; i < dayList.length; i++) {
        const p1 = S.revenue[i] - (S.baseCost[i] + S.fee[i] + S.ads[i]);
        const p2 = p1 - (S.opCost[i] + S.refund[i]);
        S.profit1[i] = +p1.toFixed(2);
        S.profit2[i] = +p2.toFixed(2);
      }
      const sum = (a) => +a.reduce((x, y) => x + (y || 0), 0).toFixed(2);
      result[sellerName].totals = {
        items: S.items.reduce((x, y) => x + (y || 0), 0),
        revenue: sum(S.revenue),
        baseCost: sum(S.baseCost),
        ads: sum(S.ads),
        fee: sum(S.fee),
        opCost: sum(S.opCost),
        refund: sum(S.refund),
        profit1: sum(S.profit1),
        profit2: sum(S.profit2),
      };
    }

    const dates = dayList.map(labelDDMM);
    return res.json({ date: dates, data: result });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ message: "Get report failed", error: e.message });
  }
};

const getOrderCostStatistics = async (req, res) => {
  try {
    const {
      from,
      to,
      search = "",
      sellerId,
      shopId,
      status,
      sourceType,
    } = req.query;

    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    if (fromDate) fromDate.setHours(0, 0, 0, 0);
    if (toDate) toDate.setHours(23, 59, 59, 999);

    const and = [{ amazon_finance_total: { $exists: true } }];
    if (fromDate && toDate) {
      and.push(
        {
          $expr: {
            $gte: [{ $ifNull: ["$purchase_date", "$createdAt"] }, fromDate],
          },
        },
        {
          $expr: {
            $lte: [{ $ifNull: ["$purchase_date", "$createdAt"] }, toDate],
          },
        }
      );
    }
    if (search.trim()) {
      const rx = new RegExp(search.trim(), "i");
      and.push({
        $or: [
          { orderId: rx },
          { "items.sku": rx },
          { "items.asin": rx },
          { "customer_infor.name": rx },
        ],
      });
    }
    if (sellerId) and.push({ sellerId });
    if (shopId) and.push({ shopId });
    if (status) and.push({ status });
    if (sourceType) and.push({ source_type: sourceType });

    const match = and.length ? { $and: and } : {};
    const col = mongoose.connection.collection("ordercustomproducts");

    const pipeline = [
      { $match: match },
      {
        $set: {
          _rev: {
            $convert: {
              input: { $ifNull: ["$amazon_finance_total.revenue", "$revenue"] },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          _fee: {
            $convert: {
              input: { $ifNull: ["$amazon_finance_total.fee", "$fee"] },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          _base: {
            $convert: {
              input: "$base_cost",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          _op: {
            $convert: {
              input: "$amazon_finance_total.opCost",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          _ref: {
            $convert: {
              input: "$amazon_finance_total.refund",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          _itax: {
            $convert: {
              input: "$amazon_finance_total.item_tax",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          _stax: {
            $convert: {
              input: "$amazon_finance_total.shipping_tax",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          _vendor: {
            $convert: {
              input: {
                $ifNull: [
                  "$vendor_cost",
                  "$amazon_finance_total.shipping_price",
                ],
              },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          // 👇 NEW: lấy item_promotion_discount để làm diff
          _promo: {
            $convert: {
              input: "$amazon_finance_total.item_promotion_discount",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      {
        $set: {
          profit1: {
            $round: [
              { $subtract: ["$_rev", { $add: ["$_base", "$_fee"] }] },
              2,
            ],
          },
          profit2: {
            $round: [
              {
                $subtract: [
                  "$_rev",
                  { $add: ["$_base", "$_fee", "$_op", "$_ref"] },
                ],
              },
              2,
            ],
          },
          taxLine: { $add: ["$_itax", "$_stax"] },
        },
      },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          revenue: { $sum: "$_rev" },
          profit: { $sum: "$profit1" },
          lngCost: { $sum: "$_op" },
          vendorCost: { $sum: "$_vendor" },
          refund: { $sum: "$_ref" },
          tax: { $sum: "$taxLine" },
          // 👇 NEW: tổng promotion
          promo: { $sum: "$_promo" },
          // optional
          baseCost: { $sum: "$_base" },
          fee: { $sum: "$_fee" },
          profit2: { $sum: "$profit2" },
        },
      },
      {
        $project: {
          _id: 0,
          orders: 1,
          revenue: { $round: ["$revenue", 2] },
          profit: { $round: ["$profit", 2] },
          lngCost: { $round: ["$lngCost", 2] },
          vendorCost: { $round: ["$vendorCost", 2] },
          // 👇 NEW: diff = tổng item_promotion_discount
          diff: { $round: ["$promo", 2] },
          refund: { $round: ["$refund", 2] },
          tax: { $round: ["$tax", 2] },
          baseCost: { $round: ["$baseCost", 2] },
          fee: { $round: ["$fee", 2] },
          profit2: { $round: ["$profit2", 2] },
        },
      },
    ];

    const [
      stats = {
        orders: 0,
        revenue: 0,
        profit: 0,
        lngCost: 0,
        vendorCost: 0,
        diff: 0,
        refund: 0,
        tax: 0,
      },
    ] = await col.aggregate(pipeline, { allowDiskUse: true }).toArray();

    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Failed to compute stats" });
  }
};

module.exports = {
  importReportFromFile,
  getReportMatrix,
  getOrderCostStatistics,
};
