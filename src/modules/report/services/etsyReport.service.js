const db = require("../../../models");
const EtsyOrder = db.EtsyOrder;
const AdsDailySummary = db.Ads;
const User = db.user;
const Team = db.Team;
const mongoose = require("mongoose");

const makeDayList = (fromISO, toISO) => {
    const from = new Date(fromISO);
    const to = new Date(toISO);
    const at00 = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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

class EtsyReportService {
    async getEtsyReportMatrix(query, user) {
        const { from, to, seller, userNull, team } = query;
        if (!from || !to) throw new Error("from & to are required");

        const role = user?.role || "";
        const userId = user?.userId || "";
        const isAdmin = /^admin$/i.test(role);
        const isSeller = /^seller$/i.test(role);

        if (!isAdmin && !isSeller) throw new Error("Access denied");

        const dayList = makeDayList(from, to);
        const dayIndex = new Map(dayList.map((d, i) => [iso(d), i]));
        const fromDate = new Date(from);
        const toDate = new Date(to);

        const matchStage = { saleDate: { $gte: fromDate, $lte: toDate }, status: { $nin: ["Cancelled", "Canceled", "Refund"] } };

        if (isSeller) {
            matchStage["seller.sellerId"] = new mongoose.Types.ObjectId(userId);
        } else {
            if (team && mongoose.Types.ObjectId.isValid(team)) {
                const teamDoc = await Team.findById(team).lean();
                if (teamDoc) {
                    const teamIds = [...(teamDoc.userIds || []), ...(teamDoc.leaderId ? [teamDoc.leaderId] : [])].map(id => new mongoose.Types.ObjectId(String(id)));
                    matchStage["seller.sellerId"] = { $in: teamIds };
                }
            }
            if (seller) {
                const ids = seller.split(",").map(id => new mongoose.Types.ObjectId(id.trim()));
                matchStage["seller.sellerId"] = { $in: ids };
            }
        }

        const rows = await EtsyOrder.aggregate([
            { $match: matchStage },
            { $lookup: { from: "users", localField: "seller.sellerId", foreignField: "_id", as: "sellerObj" } },
            { $addFields: { sellerName: { $ifNull: [{ $first: "$sellerObj.full_name" }, "Unknown"] }, day: { $dateTrunc: { date: "$saleDate", unit: "day", timezone: "UTC" } } } },
            { $group: { _id: { sellerId: "$seller.sellerId", sellerName: "$sellerName", day: "$day" }, items: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$etsy_finance_total.revenue", "$totals.orderTotal"] } }, fee: { $sum: { $ifNull: ["$etsy_finance_total.fee", "$totals.fee"] } }, item_tax: { $sum: { $ifNull: ["$etsy_finance_total.item_tax", "$totals.salesTax"] } }, shipping_tax: { $sum: { $ifNull: ["$etsy_finance_total.shipping_price", "$totals.shipping"] } }, item_promotion_discount: { $sum: { $ifNull: ["$etsy_finance_total.item_promotion_discount", "$totals.discountAmount"] } }, baseCost: { $sum: { $ifNull: ["$base_cost", 0] } }, refund: { $sum: { $ifNull: ["$etsy_finance_total.refund", 0] } } } },
        ]);

        const result = {};
        const zeroArr = () => Array(dayList.length).fill(0);

        rows.forEach(r => {
            const sellerName = r._id.sellerName;
            const idx = dayIndex.get(iso(r._id.day));
            if (idx == null) return;
            if (!result[sellerName]) {
                result[sellerName] = { fee: zeroArr(), refund: zeroArr(), items: zeroArr(), revenue: zeroArr(), baseCost: zeroArr(), ads: zeroArr(), shippingTax: zeroArr(), itemPromotionDiscount: zeroArr(), itemTax: zeroArr(), profit1: zeroArr(), profit2: zeroArr(), opCost: zeroArr() };
            }
            const S = result[sellerName];
            S.items[idx] = r.items;
            S.revenue[idx] = +r.revenue.toFixed(2);
            S.baseCost[idx] = +r.baseCost.toFixed(2);
            S.fee[idx] = +r.fee.toFixed(2);
            S.refund[idx] = +r.refund.toFixed(2);
            S.shippingTax[idx] = +r.shipping_tax.toFixed(2);
            S.itemPromotionDiscount[idx] = +Math.abs(r.item_promotion_discount).toFixed(2);
            S.itemTax[idx] = +r.item_tax.toFixed(2);
        });

        Object.keys(result).forEach(name => {
            const S = result[name];
            for (let i = 0; i < dayList.length; i++) {
                const p1 = S.revenue[i] - (S.baseCost[i] + S.fee[i] + S.ads[i] + S.itemTax[i] + S.shippingTax[i] + S.itemPromotionDiscount[i]);
                S.profit1[i] = +p1.toFixed(2);
                S.profit2[i] = +(p1 - S.refund[i]).toFixed(2);
            }
        });

        return { date: dayList.map(d => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`), data: result };
    }
}

module.exports = new EtsyReportService();

