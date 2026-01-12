const db = require("../models");
const OrderCustomProduct = db.orderCustomProduct;
const AdsDailySummary = db.Ads;
const { parse } = require("csv-parse/sync");
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const User = db.user;
const Shop = db.shop;

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

const importReportFromFile = async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: "Send form-data 'file' (txt)" });
    }

    const raw = req.file.buffer.toString("utf8");

    // ✅ Parse TSV, tắt cơ chế quote để không nổ khi gặp dấu "
    let rows;
    try {
      rows = parse(raw, {
        columns: true,
        delimiter: "\t",
        skip_empty_lines: true,
        bom: true,
        trim: true,
        relax_column_count: true,
        quote: false, // <<-- QUAN TRỌNG: tắt quote parsing
        record_delimiter: ["\r\n", "\n"], // ổn định xuống dòng hỗn hợp
      }).map(norm);
    } catch (e1) {
      // Fallback rất “nới tay” nếu có dòng hỏng lẻ tẻ
      rows = parse(raw, {
        columns: true,
        delimiter: "\t",
        skip_empty_lines: true,
        bom: true,
        trim: true,
        relax_column_count: true,
        relax_quotes: true, // chấp nhận quote “lệch chuẩn”
        quote: false, // vẫn tắt quote để không coi " là đặc biệt
        on_record: (rec) => rec, // giữ nguyên bản ghi
      }).map(norm);
    }

    // ====== (phần còn lại giữ nguyên) ======
    const bucket = new Map();

    for (const r of rows) {
      const orderId = r["amazon-order-id"]?.trim();
      if (!orderId) continue;

      const qty = num(r["quantity"]);
      const itemPrice = num(r["item-price"]);
      const itemTax = num(r["item-tax"]);
      const shippingPrice = num(r["shipping-price"]);
      const shippingTax = num(r["shipping-tax"]);
      const discount = num(r["item-promotion-discount"]);

      const revenue = itemPrice + shippingPrice;
      const fee = 0.17 * (itemPrice + shippingPrice);

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
        purchase_date_raw: r["purchase-date"],
      };

      acc.quantity += qty;
      acc.item_price += itemPrice;
      acc.item_tax += itemTax;
      acc.shipping_price += shippingPrice;
      acc.shipping_tax += shippingTax;
      acc.item_promotion_discount += Math.abs(discount);
      acc.fee += fee;
      acc.revenue += revenue;

      bucket.set(orderId, acc);
    }

    const col = mongoose.connection.collection("ordercustomproducts");
    const ops = [];

    for (const acc of bucket.values()) {
      const aft = {
        item_price: +acc.item_price.toFixed(2),
        item_tax: +acc.item_tax.toFixed(2),
        shipping_price: +acc.shipping_price.toFixed(2),
        shipping_tax: +acc.shipping_tax.toFixed(2),
        item_promotion_discount: +acc.item_promotion_discount.toFixed(2),
        fee: +acc.fee.toFixed(2),
        revenue: +acc.revenue.toFixed(2),
        opCost: 0,
        refund: 0,
        computed_at: new Date(),
      };

      const d = acc.purchase_date_raw ? new Date(acc.purchase_date_raw) : null;
      const hasValidPurchaseDate = d && !isNaN(d);

      ops.push({
        updateOne: {
          filter: { orderId: acc.orderId },
          update: [
            {
              $set: {
                amazon_total_quantity: acc.quantity,
                amazon_finance_total: aft,
                ...(hasValidPurchaseDate
                  ? { purchase_date: { $ifNull: ["$purchase_date", d] } }
                  : {}),
              },
            },
            {
              $set: {
                "amazon_finance_total.profit1": {
                  $round: [
                    {
                      $subtract: [
                        aft.revenue,
                        {
                          $add: [
                            { $ifNull: ["$base_cost", 0] },
                            aft.fee,
                            aft.item_tax,
                            aft.shipping_tax,
                            aft.item_promotion_discount,
                          ],
                        },
                      ],
                    },
                    2,
                  ],
                },
              },
            },
            {
              $set: {
                "amazon_finance_total.profit2": {
                  $round: [
                    {
                      $subtract: [
                        "$amazon_finance_total.profit1",
                        {
                          $add: [
                            { $ifNull: ["$amazon_finance_total.refund", 0] },
                            { $ifNull: ["$amazon_finance_total.opCost", 0] },
                          ],
                        },
                      ],
                    },
                    2,
                  ],
                },
              },
            },
          ],
          upsert: false,
        },
      });
    }

    if (req.query.dryRun === "true") {
      return res.json({
        message: "DRY-RUN: no writes executed",
        ordersParsed: bucket.size,
        opsCount: ops.length,
      });
    }

    let bulkResult = null;
    if (ops.length) {
      bulkResult = await col.bulkWrite(ops, { ordered: false });
    }

    res.json({
      message:
        "Imported: HARD-OVERWRITE amazon_finance_total; profit fields computed with new formula; purchase_date set-if-missing",
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

    // ===== opCost cố định =====
    const OPCOST_PER_PERSON_PER_DAY = 30;

    // ===== EXCLUDE user khỏi opCost =====
    const OP_COST_EXCLUDE_USER_IDS = new Set([
      "68b93ed3f02eed8dec002ee3", // boss
    ]);

    // ===== 1) chuẩn bị date list =====
    const dayList = makeDayList(from, to);
    const dayIndex = new Map(dayList.map((d, i) => [iso(d), i]));
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // ===== 2) Build match theo quyền & query =====
    const matchStage = {
      purchase_date: { $gte: fromDate, $lte: toDate },
      amazon_finance_total: { $exists: true, $ne: null },

      // NEW: loại bỏ đơn hủy khỏi report
      status: { $nin: ["Cancelled", "Canceled"] },
    };

    let sellerIdSet = null;
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

    // ===== 3) Aggregation đơn hàng =====
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
          items: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$amazon_finance_total.revenue", 0] } },
          fee: { $sum: { $ifNull: ["$amazon_finance_total.fee", 0] } },
          shipping_tax: {
            $sum: { $ifNull: ["$amazon_finance_total.shipping_tax", 0] },
          },
          item_promotion_discount: {
            $sum: {
              $ifNull: ["$amazon_finance_total.item_promotion_discount", 0],
            },
          },
          item_tax: {
            $sum: { $ifNull: ["$amazon_finance_total.item_tax", 0] },
          },
          baseCost: { $sum: { $ifNull: ["$base_cost", 0] } },
          ads: { $sum: { $ifNull: ["$ads", 0] } },
          opCost: { $sum: { $ifNull: ["$op_cost", 0] } },
          refund: { $sum: { $ifNull: ["$amazon_finance_total.refund", 0] } },
        },
      },
      { $sort: { "_id.day": 1 } },
    ]);

    // ===== 4) Lấy dữ liệu ADS từ AdsDailySummary =====
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
        if (sellerIdSet && !sellerIdSet.has(String(sid))) continue;
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

    // map sellerName -> sellerId (để tính opCost theo start/end)
    const sellerNameToId = new Map();

    for (const r of rows) {
      const sellerName = r._id.sellerName || "Unknown";
      const idx = dayIndex.get(iso(r._id.day));
      if (idx == null) continue;

      if (!sellerNameToId.has(sellerName) && r?._id?.sellerId) {
        sellerNameToId.set(sellerName, String(r._id.sellerId));
      }

      if (!result[sellerName]) {
        result[sellerName] = {
          fee: zeroArr(),
          opCost: zeroArr(),
          refund: zeroArr(),
          items: zeroArr(),
          revenue: zeroArr(),
          baseCost: zeroArr(),
          ads: zeroArr(),
          shippingTax: zeroArr(),
          itemPromotionDiscount: zeroArr(),
          itemTax: zeroArr(),
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
      S.ads[idx] = +(r.ads || 0).toFixed(2);
      S.shippingTax[idx] = +(r.shipping_tax || 0).toFixed(2);
      S.itemPromotionDiscount[idx] = +(
        Math.abs(r.item_promotion_discount) || 0
      ).toFixed(2);
      S.itemTax[idx] = +(r.item_tax || 0).toFixed(2);
    }

    // ===== 6) Ghi đè ADS từ AdsDailySummary =====
    for (const [key, val] of adsMap.entries()) {
      const [sid, dayIso] = key.split("|");
      const idx = dayIndex.get(dayIso);
      if (idx == null) continue;

      const sellerName = val.sellerName || "Unknown";
      if (!sellerNameToId.has(sellerName) && sid) {
        sellerNameToId.set(sellerName, String(sid));
      }

      if (!result[sellerName]) {
        result[sellerName] = {
          fee: zeroArr(),
          opCost: zeroArr(),
          refund: zeroArr(),
          items: zeroArr(),
          revenue: zeroArr(),
          baseCost: zeroArr(),
          ads: zeroArr(),
          shippingTax: zeroArr(),
          itemPromotionDiscount: zeroArr(),
          itemTax: zeroArr(),
          profit1: zeroArr(),
          profit2: zeroArr(),
        };
      }
      result[sellerName].ads[idx] = +(val.spend || 0).toFixed(2);
    }

    // ===== 6.5) Tính opCost theo start_seller / end_seller + loại trừ user boss =====
    const fixedOpCost = Number(OPCOST_PER_PERSON_PER_DAY || 0);

    // helper: đưa Date về đầu ngày UTC (00:00:00.000Z)
    const toUtcDayStart = (dt) => {
      if (!dt) return null;
      const d = new Date(dt);
      return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      );
    };

    const sellerIdsForOp = Array.from(sellerNameToId.values())
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => String(id));

    const sellerObjectIdsForOp = sellerIdsForOp
      .filter((id) => !OP_COST_EXCLUDE_USER_IDS.has(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    // Map sellerId -> { startDay, endDay }
    const sellerWorkMap = new Map();
    if (sellerObjectIdsForOp.length) {
      const userDocs = await User.find(
        { _id: { $in: sellerObjectIdsForOp } },
        { _id: 1, start_seller: 1, end_seller: 1 }
      ).lean();

      for (const u of userDocs) {
        // ✅ truncate về đầu ngày UTC để tính luôn ngày start
        const startDay = toUtcDayStart(u.start_seller);
        const endDay = toUtcDayStart(u.end_seller);

        sellerWorkMap.set(String(u._id), {
          startDay,
          endDay, // có thể null
        });
      }
    }

    // nếu chưa có end_seller => tính tới min(toDate, hôm nay) (đưa về đầu ngày UTC)
    const today = new Date();
    const effectiveNow = today < toDate ? today : toDate;
    const effectiveEndDay = toUtcDayStart(effectiveNow);

    // Set opCost theo từng ngày trong range làm việc (inclusive)
    for (const sellerName of Object.keys(result)) {
      const S = result[sellerName];
      const sellerIdStr = sellerNameToId.get(sellerName);

      // ✅ boss => opCost = 0 toàn bộ
      if (sellerIdStr && OP_COST_EXCLUDE_USER_IDS.has(String(sellerIdStr))) {
        for (let i = 0; i < dayList.length; i++) S.opCost[i] = 0;
        continue;
      }

      if (!sellerIdStr || !sellerWorkMap.has(String(sellerIdStr))) {
        for (let i = 0; i < dayList.length; i++) S.opCost[i] = 0;
        continue;
      }

      const { startDay, endDay } = sellerWorkMap.get(String(sellerIdStr));
      // ✅ nếu không có end_seller -> dùng effectiveEndDay
      const endInclusive = endDay || effectiveEndDay;

      for (let i = 0; i < dayList.length; i++) {
        // dayList[i] là Date (đầu ngày) => so inclusive theo ngày
        const d = toUtcDayStart(dayList[i]);

        const inRange =
          (!startDay || d >= startDay) && (!endInclusive || d <= endInclusive);

        S.opCost[i] = inRange ? +fixedOpCost.toFixed(2) : 0;
      }
    }

    // ===== 7) Tính profit1/profit2 + totals =====
    for (const sellerName of Object.keys(result)) {
      const S = result[sellerName];
      for (let i = 0; i < dayList.length; i++) {
        const p1 =
          S.revenue[i] -
          (S.baseCost[i] +
            S.fee[i] +
            S.ads[i] +
            S.shippingTax[i] +
            Math.abs(S.itemPromotionDiscount[i]) +
            S.itemTax[i]);

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
      statuses, // chuỗi "Pending,Shipped"
      status, // fallback 1 giá trị
      sellerId, // nếu muốn cho admin filter tường minh theo user khác
      shopName,
      platform,
      isNoCostCenter,
      financialStatus,
      sevenDayAlert,
      userNull, // chỉ Admin
      noPsd,
      shippingType,
      openCase,
    } = req.query;

    // ===== RBAC =====
    const role = req.user?.role || "";
    const tokenUserId = req.user?.userId || "";
    const isAdmin = /^admin$/i.test(role);
    const isSeller = /^seller$/i.test(role);

    const matchStage = {};

    // Seller chỉ xem đơn của mình
    if (isSeller) {
      if (!mongoose.Types.ObjectId.isValid(tokenUserId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      matchStage.sellerId = new mongoose.Types.ObjectId(tokenUserId);
    } else if (isAdmin) {
      // Admin có thể xem đơn không có seller (nếu bật userNull)
      if (userNull === "true") matchStage.sellerId = { $in: [null, undefined] };
      // Hoặc xem theo sellerId chỉ định
      if (sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
        matchStage.sellerId = new mongoose.Types.ObjectId(sellerId);
      }
    }

    // statuses (nhiều)
    const statusesArr =
      (statuses &&
        statuses
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) ||
      (status ? [status] : []);
    if (statusesArr.length) matchStage.status = { $in: statusesArr };

    // search
    if (search && search.trim()) {
      const rx = new RegExp(search.trim(), "i");
      matchStage.$or = [
        { orderId: rx },
        { "customer_infor.name": rx },
        { "items.sku": rx },
        { "items.asin": rx },
      ];
    }

    // openCase
    if (openCase === "true")
      matchStage.case = { $exists: true, $not: { $size: 0 } };

    // Date inclusive với purchase_date fallback createdAt
    if (from || to) {
      const fromDate = from ? new Date(from) : null;
      const toDate = to ? new Date(to) : null;
      const dateExpr = { $ifNull: ["$purchase_date", "$createdAt"] };
      const bounds = [];
      if (fromDate) bounds.push({ $gte: [dateExpr, fromDate] });
      if (toDate) bounds.push({ $lte: [dateExpr, toDate] });
      matchStage.$expr = { $and: bounds };
    }

    if (isNoCostCenter === "true") matchStage.base_cost = { $in: [null, 0] };
    if (financialStatus) matchStage.financialStatus = financialStatus;
    if (sevenDayAlert === "true") {
      const today = new Date();
      const d7 = new Date(today);
      d7.setDate(today.getDate() + 7);
      matchStage.deliveryDate = { $lte: d7 };
    }
    if (platform) matchStage.platform = platform;
    if (noPsd === "true")
      matchStage["items.snapshotImage"] = { $in: [null, ""] };

    // shippingType: "A,B,C"
    if (shippingType && shippingType.trim() !== "") {
      const valid = [
        "Second Day",
        "Ground",
        "Overnight",
        "Economy",
        "Standard",
        "Expedited",
      ];
      const types = shippingType
        .split(",")
        .map((t) => t.trim())
        .filter((t) => valid.includes(t));
      if (types.length === 1) matchStage.shipping_type = types[0];
      else if (types.length > 1) matchStage.shipping_type = { $in: types };
    }

    const col = mongoose.connection.collection("ordercustomproducts");

    // Pre lookup để lọc theo shopName (giống list)
    const preStages = [
      {
        $lookup: {
          from: "shops",
          localField: "shopId",
          foreignField: "_id",
          as: "shop",
        },
      },
      { $unwind: "$shop" },
    ];
    if (shopName && shopName.trim() !== "") {
      preStages.push({
        $match: { "shop.name": { $regex: new RegExp(shopName.trim(), "i") } },
      });
    }

    const pipeline = [
      ...preStages,
      { $match: matchStage },

      // Chuẩn hoá số
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
              {
                $subtract: [
                  "$_rev",
                  { $add: ["$_base", "$_fee", "$_itax", "$_promo", "$_stax"] },
                ],
              },
              2,
            ],
          },
          profit2: {
            $round: [
              {
                $subtract: [
                  "$_rev",
                  {
                    $add: [
                      "$_base",
                      "$_fee",
                      "$_op",
                      "$_ref",
                      "$_itax",
                      "$_promo",
                      "$_stax",
                    ],
                  },
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
          profit: { $sum: "$profit1" }, // nếu muốn profit2 => đổi sang "$profit2"
          lngCost: { $sum: "$_op" },
          vendorCost: { $sum: "$_base" },
          refund: { $sum: "$_ref" },
          tax: { $sum: "$taxLine" },
          promo: { $sum: "$_promo" }, // Diff = tổng item_promotion_discount
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
          diff: { $round: ["$promo", 2] },
          refund: { $round: ["$refund", 2] },
          tax: { $round: ["$tax", 2] },
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

const importAmazonRefundCSV = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "CSV file is required" });
    }

    // ===== 1) Read + strip BOM =====
    let csvText = req.file.buffer.toString("utf8");
    if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);

    // ===== 2) Parse CSV =====
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      relax_column_count: true,
    });

    // ===== 3) Collect Order IDs (unique) =====
    const orderIdSet = new Set();
    for (const r of records) {
      const orderId = (r["Order ID"] ?? r["\ufeffOrder ID"] ?? "")
        .toString()
        .trim();
      if (orderId) orderIdSet.add(orderId);
    }

    const orderIds = Array.from(orderIdSet);
    if (orderIds.length === 0) {
      return res.json({
        message: "No Order ID found in CSV",
        updatedOrders: 0,
      });
    }

    // ===== 4) Fetch matching orders to get revenue =====
    // Chỉ lấy revenue để set refund = revenue
    const docs = await OrderCustomProduct.find(
      { orderId: { $in: orderIds } },
      { orderId: 1, "amazon_finance_total.revenue": 1 }
    ).lean();

    const revenueMap = new Map();
    for (const d of docs) {
      const rev = Number(d?.amazon_finance_total?.revenue || 0);
      revenueMap.set(String(d.orderId), rev);
    }

    // ===== 5) Bulk update =====
    // - refund = revenue (DB)
    // - fee/item_tax/shipping_tax/item_promotion_discount = 0
    const bulkOps = [];
    const notFound = [];

    for (const orderId of orderIds) {
      if (!revenueMap.has(orderId)) {
        notFound.push(orderId);
        continue;
      }

      const revenue = revenueMap.get(orderId) || 0;

      bulkOps.push({
        updateOne: {
          filter: { orderId },
          update: {
            $set: {
              "amazon_finance_total.refund": +Number(revenue).toFixed(2),
              "amazon_finance_total.fee": 0,
              "amazon_finance_total.item_tax": 0,
              "amazon_finance_total.shipping_tax": 0,
              "amazon_finance_total.item_promotion_discount": 0,
            },
          },
        },
      });
    }

    let bulkResult = null;
    if (bulkOps.length) {
      bulkResult = await OrderCustomProduct.bulkWrite(bulkOps, {
        ordered: false,
      });
    }

    return res.json({
      message: "Import refund orders success",
      totalOrderIdsInFile: orderIds.length,
      matchedOrders: bulkResult?.matchedCount || 0,
      updatedOrders: bulkResult?.modifiedCount || 0,
      notFoundCount: notFound.length,
      // nếu bạn không muốn trả list dài, có thể bỏ field này
      notFoundOrderIds: notFound.slice(0, 200),
    });
  } catch (error) {
    console.error("IMPORT REFUND ORDERS ERROR:", error);
    return res.status(500).json({
      message: "Import refund orders failed",
      error: error.message,
    });
  }
};

const n2 = (v) => {
  const num = Number(v);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(2));
};

const exportOrdersCostExcel = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res
        .status(400)
        .json({ message: "from & to are required (ISO UTC)" });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res
        .status(400)
        .json({ message: "from/to must be valid ISO date" });
    }

    // ===== 1) Query DB + populate =====
    // purchase_date theo ảnh bạn gửi
    const orders = await OrderCustomProduct.find({
      purchase_date: { $gte: fromDate, $lte: toDate },
    })
      .populate({ path: "shopId", select: "name" }) // shop.name
      .populate({ path: "sellerId", select: "full_name" }) // user.full_name
      .lean();

    // ===== 2) Create workbook =====
    const wb = new ExcelJS.Workbook();
    wb.creator = "LNG";
    wb.created = new Date();

    const ws = wb.addWorksheet("Orders Cost");
    ws.views = [{ state: "frozen", ySplit: 1 }];

    ws.columns = [
      { header: "OrderId", key: "orderId", width: 22 },
      { header: "Purchase Date", key: "purchase_date", width: 22 },
      { header: "Shop", key: "shop", width: 18 },
      { header: "Seller", key: "seller", width: 22 },
      { header: "Status", key: "status", width: 14 },

      { header: "Revenue", key: "revenue", width: 12 },
      { header: "Tax", key: "tax", width: 10 },
      { header: "Shipping Tax", key: "sTax", width: 10 },
      { header: "Fee", key: "fee", width: 10 },
      { header: "Refund", key: "refund", width: 12 },
      { header: "Cost", key: "cost", width: 12 },
      { header: "Discount", key: "discount", width: 12 },
      { header: "Profit", key: "profit", width: 12 },
    ];

    ws.getRow(1).font = { bold: true };

    // ===== 3) Fill data =====
    for (const o of orders) {
      const f = o.amazon_finance_total || {};

      // Theo ảnh bạn gửi:
      // revenue, item_tax, shipping_tax, fee, item_promotion_discount, refund
      const revenue = Number(f.revenue) || 0;
      const tax = Number(f.item_tax) || 0;
      const sTax = Number(f.shipping_tax) || 0;
      const fee = Number(f.fee) || 0;
      const discount = Number(f.item_promotion_discount) || 0;
      const refund = Number(f.refund) || 0;

      // Cost: theo ảnh là base_cost
      const cost = Number(o.base_cost) || 0;

      // Profit: revenue trừ tất cả phần còn lại
      const profit = revenue - (tax + sTax + fee + refund + discount + cost);

      ws.addRow({
        orderId: o.orderId || "",
        purchase_date: o.purchase_date
          ? new Date(o.purchase_date).toISOString()
          : "",
        shop: o.shopId?.name || "",
        seller: o.sellerId?.full_name || "",
        status: o.status || "",

        revenue: n2(revenue),
        tax: n2(tax),
        sTax: n2(sTax),
        fee: n2(fee),
        refund: n2(refund),
        cost: n2(cost),
        discount: n2(discount),
        profit: n2(profit),
      });
    }

    // ===== 4) Format money columns (Revenue..Profit) =====
    // Cột tiền: F -> M
    const moneyCols = ["F", "G", "H", "I", "J", "K", "L", "M"];
    for (let r = 2; r <= ws.rowCount; r++) {
      for (const c of moneyCols) {
        ws.getCell(`${c}${r}`).numFmt = '"$"#,##0.00;-"$"#,##0.00';
      }
    }

    // ===== 5) Download response =====
    const fileName = `Report_cost.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Export failed", error: err?.message });
  }
};

const fmtDateKey = (d) => {
  // key cột dạng DD-MM (giống ảnh #2), bạn có thể đổi sang YYYY-MM-DD nếu muốn
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}`;
};

const toUTCStartOfDay = (date) => {
  const d = new Date(date);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)
  );
};

const buildDateRangeUTC = (from, to) => {
  const start = toUTCStartOfDay(from);
  const end = toUTCStartOfDay(to);

  const dates = [];
  let cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    dates.push(new Date(cur));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
};

const getIdString = (x) => {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (x._id) return String(x._id);
  return String(x);
};

const moneyFmt = '"$"#,##0.00;-"$"#,##0.00';

// ===== Controller =====
/**
 * GET /api/ads/report/export?from=...&to=...
 */
const exportAmazonAdsSpendBySellerExcel = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res
        .status(400)
        .json({ message: "from & to are required (ISO UTC)" });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res
        .status(400)
        .json({ message: "from/to must be valid ISO date" });
    }

    // Tạo list ngày để render cột (giống UI)
    const dateList = buildDateRangeUTC(fromDate, toDate);
    const dateKeys = dateList.map(fmtDateKey);

    // ===== 1) Load dữ liệu theo ngày từ DB =====
    // field 'day' trong ảnh #3 là Date (00:00:00Z)
    const docs = await AdsDailySummary.find({
      day: { $gte: toUTCStartOfDay(fromDate), $lte: toUTCStartOfDay(toDate) },
    }).lean();

    // ===== 2) Collect sellerIds + shopIds để map name =====
    const sellerIdSet = new Set();
    const shopIdSet = new Set();

    for (const doc of docs) {
      const arr = Array.isArray(doc.by_seller) ? doc.by_seller : [];
      for (const s of arr) {
        const sellerId = getIdString(s.seller);
        if (sellerId) sellerIdSet.add(sellerId);

        const byShop = Array.isArray(s.by_shop) ? s.by_shop : [];
        for (const sh of byShop) {
          const shopId = getIdString(sh.shop_id);
          if (shopId) shopIdSet.add(shopId);
        }
      }
    }

    const sellerIds = Array.from(sellerIdSet).filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );
    const shopIds = Array.from(shopIdSet).filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );

    const [users, shops] = await Promise.all([
      User.find({ _id: { $in: sellerIds } }, { full_name: 1 }).lean(),
      Shop.find({ _id: { $in: shopIds } }, { name: 1 }).lean(),
    ]);

    const userMap = new Map(
      users.map((u) => [String(u._id), u.full_name || ""])
    );
    const shopMap = new Map(shops.map((s) => [String(s._id), s.name || ""]));

    // ===== 3) Build matrix =====
    // A) By Seller (All shops)
    // sellerMatrix[sellerId] = { sellerId, sellerName, days: {dateKey: spend}, total }
    const sellerMatrix = new Map();

    // B) By Seller x Shop
    // sellerShopMatrix[`${sellerId}__${shopId}`] = { sellerId, shopId, sellerName, shopName, days, total }
    const sellerShopMatrix = new Map();

    // Index docs by dayKey để merge đúng cột ngày
    const docByDayKey = new Map();
    for (const doc of docs) {
      const dk = fmtDateKey(new Date(doc.day));
      docByDayKey.set(dk, doc);
    }

    for (const dk of dateKeys) {
      const doc = docByDayKey.get(dk);
      if (!doc) continue;

      const arr = Array.isArray(doc.by_seller) ? doc.by_seller : [];
      for (const s of arr) {
        const sellerId = getIdString(s.seller);
        if (!sellerId) continue;

        const sellerName = userMap.get(sellerId) || sellerId;

        // --- seller total spend (tất cả shop) ---
        const spend = n2(s.spend || 0);

        if (!sellerMatrix.has(sellerId)) {
          sellerMatrix.set(sellerId, {
            sellerId,
            sellerName,
            days: {},
            total: 0,
          });
        }
        const sm = sellerMatrix.get(sellerId);
        sm.days[dk] = (sm.days[dk] || 0) + spend;
        sm.total = n2(sm.total + spend);

        // --- breakdown by shop ---
        const byShop = Array.isArray(s.by_shop) ? s.by_shop : [];
        for (const sh of byShop) {
          const shopId = getIdString(sh.shop_id);
          if (!shopId) continue;

          const shopName = shopMap.get(shopId) || shopId;
          const shopSpend = n2(sh.spend || 0);

          const key = `${sellerId}__${shopId}`;
          if (!sellerShopMatrix.has(key)) {
            sellerShopMatrix.set(key, {
              sellerId,
              shopId,
              sellerName,
              shopName,
              days: {},
              total: 0,
            });
          }
          const ssm = sellerShopMatrix.get(key);
          ssm.days[dk] = (ssm.days[dk] || 0) + shopSpend;
          ssm.total = n2(ssm.total + shopSpend);
        }
      }
    }

    // Sort rows theo Total desc (giống báo cáo)
    const sellerRows = Array.from(sellerMatrix.values()).sort(
      (a, b) => (b.total || 0) - (a.total || 0)
    );
    const sellerShopRows = Array.from(sellerShopMatrix.values()).sort(
      (a, b) => (b.total || 0) - (a.total || 0)
    );

    // ===== 4) Create Excel =====
    const wb = new ExcelJS.Workbook();
    wb.creator = "LNG";
    wb.created = new Date();

    // ---------- Sheet 1: By Seller ----------
    const ws1 = wb.addWorksheet("By Seller (All Shops)");
    ws1.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];

    // Columns: Seller | Total | (date columns...)
    ws1.columns = [
      { header: "Seller", key: "seller", width: 28 },
      { header: "Total", key: "total", width: 14 },
      ...dateKeys.map((k) => ({ header: k, key: k, width: 12 })),
    ];
    ws1.getRow(1).font = { bold: true };

    for (const r of sellerRows) {
      const row = {
        seller: r.sellerName,
        total: n2(r.total),
      };
      for (const dk of dateKeys) row[dk] = n2(r.days[dk] || 0);
      ws1.addRow(row);
    }

    // Format money for Total + date cols
    for (let i = 2; i <= ws1.rowCount; i++) {
      ws1.getCell(i, 2).numFmt = moneyFmt;
      for (let c = 3; c <= ws1.columnCount; c++)
        ws1.getCell(i, c).numFmt = moneyFmt;
    }

    // ---------- Sheet 2: By Seller x Shop ----------
    const ws2 = wb.addWorksheet("By Seller x Shop");
    ws2.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];

    // Columns: Seller | Shop | Total | (date columns...)
    ws2.columns = [
      { header: "Seller", key: "seller", width: 28 },
      { header: "Shop", key: "shop", width: 22 },
      { header: "Total", key: "total", width: 14 },
      ...dateKeys.map((k) => ({ header: k, key: k, width: 12 })),
    ];
    ws2.getRow(1).font = { bold: true };

    for (const r of sellerShopRows) {
      const row = {
        seller: r.sellerName,
        shop: r.shopName,
        total: n2(r.total),
      };
      for (const dk of dateKeys) row[dk] = n2(r.days[dk] || 0);
      ws2.addRow(row);
    }

    // Format money for Total + date cols
    for (let i = 2; i <= ws2.rowCount; i++) {
      ws2.getCell(i, 3).numFmt = moneyFmt;
      for (let c = 4; c <= ws2.columnCount; c++)
        ws2.getCell(i, c).numFmt = moneyFmt;
    }

    // ===== 5) Response download =====
    const fileName = `amazon_ads_spend_${toUTCStartOfDay(fromDate)
      .toISOString()
      .slice(0, 10)}_to_${toUTCStartOfDay(toDate)
      .toISOString()
      .slice(0, 10)}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Export failed", error: err?.message });
  }
};

module.exports = {
  importReportFromFile,
  getReportMatrix,
  getOrderCostStatistics,
  importAmazonRefundCSV,
  exportOrdersCostExcel,
  exportAmazonAdsSpendBySellerExcel,
};
