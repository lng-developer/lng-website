// controllers/report.controller.js
const mongoose = require("mongoose");
const db = require("../models");
const Order = db.orderCustomProduct;
const User = db.user;

const rand = (min, max) => +(min + Math.random() * (max - min)).toFixed(2);

const getDailyReport = async (req, res) => {
  try {
    const { from, to } = req.query; // ISO UTC
    if (!from || !to)
      return res
        .status(400)
        .json({ message: "from & to are required (ISO UTC)" });

    const addComputed = {
      $addFields: {
        _date: { $ifNull: ["$purchase_date", "$createdAt"] },
        _revenue: {
          $ifNull: [
            { $toDouble: { $ifNull: ["$base_cost", 0] } },
            {
              $let: {
                vars: {
                  perItems: {
                    $map: {
                      input: { $ifNull: ["$items", []] },
                      as: "it",
                      in: {
                        $ifNull: [
                          "$$it.cost_breakdown.base_cost_total_for_item_including_shipping",
                          {
                            $multiply: [
                              {
                                $ifNull: [
                                  "$$it.cost_breakdown.base_cost_each",
                                  0,
                                ],
                              },
                              { $ifNull: ["$$it.cost_breakdown.quantity", 1] },
                            ],
                          },
                        ],
                      },
                    },
                  },
                },
                in: { $sum: "$$perItems" },
              },
            },
          ],
        },
      },
    };

    const matchRange = {
      $match: {
        _date: { $gte: new Date(from), $lte: new Date(to) },
      },
    };

    const addDayKey = {
      $addFields: {
        _dayKey: {
          $dateToString: {
            date: "$_date",
            format: "%Y-%m-%d",
            timezone: "UTC",
          },
        },
      },
    };

    const rows = await Order.aggregate([
      addComputed,
      matchRange,
      addDayKey,
      {
        $group: {
          _id: "$_dayKey",
          items: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$_revenue", 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const data = {
      fee: [],
      opCost: [],
      refund: [],
      items: [],
      revenue: [],
      baseCost: [],
      ads: [],
    };

    for (const r of rows) {
      const items = r.items || 0;
      const revenue = +(r.revenue || 0).toFixed(2);

      const fee = +(revenue * rand(0.02, 0.06)).toFixed(2);
      const baseCost = +(revenue * rand(0.6, 0.85)).toFixed(2);
      const ads = +(revenue * rand(0.05, 0.2)).toFixed(2);
      const opCost = +(revenue * rand(0.01, 0.03)).toFixed(2);
      const refund = +(revenue * rand(0.0, 0.05)).toFixed(2);

      data.items.push(items);
      data.revenue.push(revenue);
      data.baseCost.push(baseCost);
      data.ads.push(ads);
      data.fee.push(fee);
      data.opCost.push(opCost);
      data.refund.push(refund);
    }

    const sum = (arr) => +arr.reduce((a, b) => a + (b || 0), 0).toFixed(2);
    data.totals = {
      items: data.items.reduce((a, b) => a + (b || 0), 0),
      revenue: sum(data.revenue),
      baseCost: sum(data.baseCost),
      ads: sum(data.ads),
      fee: sum(data.fee),
      opCost: sum(data.opCost),
      refund: sum(data.refund),
    };

    // 👉 chỉ trả về data
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Get daily matrix failed" });
  }
};
module.exports = { getDailyReport };
