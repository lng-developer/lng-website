const db = require("../models");
const EtsyOrder = db.EtsyOrder;
const AdsDailySummary = db.Ads;
const User = db.user;
const Team = db.Team;
const mongoose = require("mongoose");

// Helpers
const makeDayList = (fromISO, toISO) => {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const at00 = (d) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const days = [];
  let d = at00(from);
  const end = at00(to);
  while (d <= end) {
    days.push(new Date(d));
    d = new Date(d.getTime() + 86400000);
  }
  return days;
};
const iso = (d) => d.toISOString();
const pad2 = (n) => String(n).padStart(2, "0");
const labelDDMM = (d) => `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}`;

const getEtsyReportMatrix = async (req, res) => {
  try {
    const { from, to, seller, userNull, team } = req.query;

    if (!from || !to) {
      return res.status(400).json({ message: "from & to are required (ISO UTC)" });
    }

    // ===== 0) Access Control =====
    const role = req.user?.role || "";
    const userId = req.user?.userId || "";
    const isAdmin = /^admin$/i.test(role);
    const isSeller = /^seller$/i.test(role);

    if (!isAdmin && !isSeller) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (isSeller && !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user id in token" });
    }

    // ===== opCost constants =====
    const OPCOST_PER_PERSON_PER_DAY = 0;
    const OP_COST_EXCLUDE_USER_IDS = new Set(["68b93ed3f02eed8dec002ee3"]);

    // ===== 1) Prepared date list =====
    const dayList = makeDayList(from, to);
    const dayIndex = new Map(dayList.map((d, i) => [iso(d), i]));
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // ===== 2) Match stage for EtsyOrder =====
    const matchStage = {
      saleDate: { $gte: fromDate, $lte: toDate },
      status: { $nin: ["Cancelled", "Canceled", "Refund"] },
    };

    let sellerIdSet = null;
    let teamUserObjectIds = null;

    if (isAdmin && team) {
      if (!mongoose.Types.ObjectId.isValid(team)) {
        return res.status(400).json({ message: "Invalid team id" });
      }
      const teamDoc = await Team.findById(team, { userIds: 1, leaderId: 1 }).lean();
      if (!teamDoc) {
        return res.status(404).json({ message: "Team not found" });
      }

      const rawIds = [...(teamDoc.userIds || []), ...(teamDoc.leaderId ? [teamDoc.leaderId] : [])];
      const uniq = new Map();
      for (const id of rawIds) {
        const sid = String(id || "");
        if (!mongoose.Types.ObjectId.isValid(sid)) continue;
        uniq.set(sid, new mongoose.Types.ObjectId(sid));
      }

      teamUserObjectIds = Array.from(uniq.values());
      sellerIdSet = new Set(Array.from(uniq.keys()));
    }

    if (isSeller) {
      matchStage["seller.sellerId"] = new mongoose.Types.ObjectId(userId);
      sellerIdSet = new Set([String(userId)]);
    } else {
      if (teamUserObjectIds && teamUserObjectIds.length) {
        matchStage["seller.sellerId"] = { $in: teamUserObjectIds };
      }
      if (seller) {
        const ids = seller.split(",")
          .map((s) => s.trim())
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
          .map((id) => new mongoose.Types.ObjectId(id));

        if (ids.length) {
          if (matchStage["seller.sellerId"] && matchStage["seller.sellerId"].$in) {
            const sellerIdStrSet = new Set(ids.map(String));
            const intersect = matchStage["seller.sellerId"].$in.filter((x) => sellerIdStrSet.has(String(x)));
            matchStage["seller.sellerId"] = { $in: intersect };
            sellerIdSet = new Set(intersect.map(String));
          } else {
            matchStage["seller.sellerId"] = ids.length === 1 ? ids[0] : { $in: ids };
            sellerIdSet = new Set(ids.map(String));
          }
        }
      }

      if (userNull === "true" && !(teamUserObjectIds && teamUserObjectIds.length)) {
        if (matchStage["seller.sellerId"]) {
          if (matchStage["seller.sellerId"].$in) matchStage["seller.sellerId"].$in.push(null, undefined);
          else matchStage["seller.sellerId"] = { $in: [matchStage["seller.sellerId"], null, undefined] };
        } else {
          matchStage["seller.sellerId"] = { $in: [null, undefined] };
        }
      }
    }

    // ===== 3) Aggregation on EtsyOrder =====
    const rows = await EtsyOrder.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from: "users",
          localField: "seller.sellerId",
          foreignField: "_id",
          as: "sellerObj",
        },
      },
      {
        $addFields: {
          sellerName: { $ifNull: [{ $first: "$sellerObj.full_name" }, "Unknown"] },
          day: {
            $dateTrunc: { date: "$saleDate", unit: "day", timezone: "UTC" },
          },
        },
      },
      {
        $group: {
          _id: { sellerId: "$seller.sellerId", sellerName: "$sellerName", day: "$day" },
          items: { $sum: { $cond: [{ $isArray: "$items" }, { $size: "$items" }, 1] } },

          // Based on newly added etsy_finance_total logic if available, otherwise fallback to totals
          // User requested: Revenue được lấy từ ordertotal
          revenue: { $sum: { $ifNull: ["$etsy_finance_total.revenue", "$totals.orderTotal"] } },
          fee: { $sum: { $ifNull: ["$etsy_finance_total.fee", "$totals.fee"] } },
          item_tax: { $sum: { $ifNull: ["$etsy_finance_total.item_tax", "$totals.salesTax"] } },
          shipping_tax: { $sum: { $ifNull: ["$etsy_finance_total.shipping_price", "$totals.shipping"] } }, // Mapped shipping to shipping_tax analogous slot for report shape
          item_promotion_discount: { $sum: { $ifNull: ["$etsy_finance_total.item_promotion_discount", "$totals.discountAmount"] } },

          baseCost: { $sum: { $ifNull: ["$base_cost", 0] } },
          refund: { $sum: { $ifNull: ["$etsy_finance_total.refund", 0] } },
        }
      },
      { $sort: { "_id.day": 1 } },
    ]);
    // ===== 4) Fetch Ads (similar logic to Amazon) =====
    // const adsDocs = await AdsDailySummary.find(
    //   { day: { $gte: dayList[0], $lte: dayList[dayList.length - 1] } },
    //   { day: 1, by_seller: 1 }
    // ).lean();

    // const adsMap = new Map();
    // for (const doc of adsDocs) {
    //   const dayIso = iso(doc.day);
    //   for (const row of doc.by_seller || []) {
    //     const sid = row?.seller?._id;
    //     if (!sid) continue;
    //     if (sellerIdSet && !sellerIdSet.has(String(sid))) continue;
    //     const key = `${String(sid)}|${dayIso}`;
    //     adsMap.set(key, {
    //       spend: Number(row.spend || 0),
    //       sellerName: row.seller.full_name || "Unknown",
    //     });
    //   }
    // }

    // ===== 5) Group results =====
    const result = {};
    const zeroArr = () => Array(dayList.length).fill(0);
    const sellerNameToId = new Map();

    for (const r of rows) {
      const sellerName = r._id.sellerName || "Unknown";
      const idx = dayIndex.get(iso(r._id.day));
      if (idx == null) continue;

      if (!sellerNameToId.has(sellerName) && r?._id?.sellerId) {
        sellerNameToId.set(sellerName, String(r._id.sellerId));
      }

      if (!result[sellerName]) {
        result[sellerName] = { fee: zeroArr(), opCost: zeroArr(), refund: zeroArr(), items: zeroArr(), revenue: zeroArr(), baseCost: zeroArr(), ads: zeroArr(), shippingTax: zeroArr(), itemPromotionDiscount: zeroArr(), itemTax: zeroArr(), profit1: zeroArr(), profit2: zeroArr() };
      }

      const S = result[sellerName];
      S.items[idx] = r.items || 0;
      S.revenue[idx] = +(r.revenue || 0).toFixed(2);
      S.baseCost[idx] = +(r.baseCost || 0).toFixed(2);
      S.fee[idx] = +(r.fee || 0).toFixed(2);
      S.refund[idx] = +(r.refund || 0).toFixed(2);
      S.shippingTax[idx] = +(r.shipping_tax || 0).toFixed(2); // Actually mapping 'shipping' here
      S.itemPromotionDiscount[idx] = +(Math.abs(r.item_promotion_discount) || 0).toFixed(2);
      S.itemTax[idx] = +(r.item_tax || 0).toFixed(2);
      // opCost and ads filled below
    }

    // ===== 6) Overwrite Ads =====
    // for (const [key, val] of adsMap.entries()) {
    //   const [sid, dayIso] = key.split("|");
    //   const idx = dayIndex.get(dayIso);
    //   if (idx == null) continue;
    //   const sellerName = val.sellerName || "Unknown";
    //   if (!sellerNameToId.has(sellerName) && sid) sellerNameToId.set(sellerName, String(sid));

    //   if (!result[sellerName]) {
    //     result[sellerName] = { fee: zeroArr(), opCost: zeroArr(), refund: zeroArr(), items: zeroArr(), revenue: zeroArr(), baseCost: zeroArr(), ads: zeroArr(), shippingTax: zeroArr(), itemPromotionDiscount: zeroArr(), itemTax: zeroArr(), profit1: zeroArr(), profit2: zeroArr() };
    //   }
    //   result[sellerName].ads[idx] = +(val.spend || 0).toFixed(2);
    // }

    // ===== 6.5) Compute OpCost (Start/End Work Day logic) =====
    const fixedOpCost = Number(OPCOST_PER_PERSON_PER_DAY);
    const toUtcDayStart = (dt) => {
      if (!dt) return null;
      const d = new Date(dt);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    };

    const sellerIdsForOp = Array.from(sellerNameToId.values()).filter((id) => mongoose.Types.ObjectId.isValid(id)).map(String);
    const sellerObjectIdsForOp = sellerIdsForOp.filter((id) => !OP_COST_EXCLUDE_USER_IDS.has(id)).map((id) => new mongoose.Types.ObjectId(id));
    const sellerWorkMap = new Map();

    if (sellerObjectIdsForOp.length) {
      const userDocs = await User.find({ _id: { $in: sellerObjectIdsForOp } }, { _id: 1, start_seller: 1, end_seller: 1 }).lean();
      for (const u of userDocs) {
        sellerWorkMap.set(String(u._id), { startDay: toUtcDayStart(u.start_seller), endDay: toUtcDayStart(u.end_seller) });
      }
    }

    const today = new Date();
    const effectiveNow = today < toDate ? today : toDate;
    const effectiveEndDay = toUtcDayStart(effectiveNow);

    for (const sellerName of Object.keys(result)) {
      const S = result[sellerName];
      const sellerIdStr = sellerNameToId.get(sellerName);

      if (sellerIdStr && OP_COST_EXCLUDE_USER_IDS.has(String(sellerIdStr))) {
        for (let i = 0; i < dayList.length; i++) S.opCost[i] = 0;
        continue;
      }
      if (!sellerIdStr || !sellerWorkMap.has(String(sellerIdStr))) {
        for (let i = 0; i < dayList.length; i++) S.opCost[i] = 0;
        continue;
      }

      const { startDay, endDay } = sellerWorkMap.get(String(sellerIdStr));
      const endInclusive = endDay || effectiveEndDay;

      for (let i = 0; i < dayList.length; i++) {
        const d = toUtcDayStart(dayList[i]);
        const inRange = (!startDay || d >= startDay) && (!endInclusive || d <= endInclusive);
        S.opCost[i] = inRange ? +fixedOpCost.toFixed(2) : 0;
      }
    }

    // ===== 7) Compute Profit & Totals =====
    for (const sellerName of Object.keys(result)) {
      const S = result[sellerName];
      for (let i = 0; i < dayList.length; i++) {
        // user requested formula: 
        // profit1: Revenue - (BaseCost + Fee + Ads + Tax + ShipTax + Discount)
        // profit2: Profit1 - (OpCost của seller + Tiền Hoàn trả)
        const p1 = S.revenue[i] - (S.baseCost[i] + S.fee[i] + S.ads[i] + S.itemTax[i] + S.shippingTax[i] + S.itemPromotionDiscount[i]);
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
        profit2: sum(S.profit2)
      };
    }

    const dates = dayList.map(labelDDMM);
    return res.json({ date: dates, data: result });
  } catch (err) {
    console.error("getEtsyReportMatrix Error:", err);
    return res.status(500).json({ message: "Failed to get Etsy report", error: err.message });
  }
};

module.exports = {
  getEtsyReportMatrix
};
