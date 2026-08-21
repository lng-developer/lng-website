jest.mock("../../models", () => ({
  EtsyOrder: { aggregate: jest.fn() },
  EtsyAdsDailySummary: { find: jest.fn() },
  user: { find: jest.fn() },
  Team: { findById: jest.fn() },
}));

const db = require("../../models");
const controller = require("../etsyReport.controller");

const chain = (rows = []) => ({ lean: jest.fn().mockResolvedValue(rows) });
const makeRes = () => {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};
const reportPipeline = async (query = {}, user = { role: "Admin" }) => {
  db.EtsyOrder.aggregate.mockResolvedValue([]);
  db.EtsyAdsDailySummary.find.mockReturnValue(chain());
  db.user.find.mockReturnValue(chain());
  const res = makeRes();
  await controller.getEtsyReportMatrix({
    query: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z", ...query },
    user,
  }, res);
  return db.EtsyOrder.aggregate.mock.calls.at(-1)[0];
};

test("groups Etsy report rows by each item seller instead of the order seller", async () => {
  db.EtsyOrder.aggregate.mockResolvedValue([]);
  db.EtsyAdsDailySummary.find.mockReturnValue(chain());
  db.user.find.mockReturnValue(chain());

  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  await controller.getEtsyReportMatrix({
    query: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z" },
    user: { role: "Admin" },
  }, res);

  const pipeline = db.EtsyOrder.aggregate.mock.calls[0][0];
  expect(pipeline).toContainEqual({ $unwind: "$items" });
  expect(pipeline).toContainEqual(expect.objectContaining({
    $lookup: expect.objectContaining({ localField: "items.seller.sellerId" }),
  }));
  expect(pipeline).toContainEqual(expect.objectContaining({
    $group: expect.objectContaining({ _id: expect.objectContaining({ sellerId: "$itemSellerId" }) }),
  }));
});

test("uses item seller first and falls back to the legacy order seller", async () => {
  const pipeline = await reportPipeline();
  expect(pipeline).toContainEqual(expect.objectContaining({
    $addFields: expect.objectContaining({
      itemSellerId: { $ifNull: ["$items.seller.sellerId", "$seller.sellerId"] },
    }),
  }));
});

test("allocates order-level money by item total and splits a zero-total order evenly", async () => {
  const pipeline = await reportPipeline();
  const allocationStage = pipeline.find((stage) => stage.$addFields?.allocationRatio);
  expect(allocationStage.$addFields.allocationRatio).toEqual({
    $cond: [
      { $gt: ["$orderItemAmount", 0] },
      { $divide: ["$itemAmount", "$orderItemAmount"] },
      { $divide: [1, "$orderItemCount"] },
    ],
  });
});

test("uses item base cost before the allocated legacy order base cost", async () => {
  const pipeline = await reportPipeline();
  const groupStage = pipeline.find((stage) => stage.$group);
  expect(groupStage.$group.baseCost).toEqual({
    $sum: {
      $ifNull: [
        "$items.cost_breakdown.base_cost_total_for_item_including_shipping",
        { $multiply: [{ $ifNull: ["$base_cost", 0] }, "$allocationRatio"] },
      ],
    },
  });
});

test("filters a seller after unwinding items, so mixed orders retain that seller's item", async () => {
  const sellerId = "68b93ed3f02eed8dec002eee";
  const pipeline = await reportPipeline({}, { role: "Seller", userId: sellerId });
  const sellerMatch = pipeline.find((stage) => stage.$match?.itemSellerId);
  expect(sellerMatch).toEqual({
    $match: { itemSellerId: { $in: [expect.any(Object)] } },
  });
  expect(pipeline[0].$match["seller.sellerId"]).toBeUndefined();
});

test("keeps a mixed-seller order's revenue, base cost, and profit separate", async () => {
  const day = new Date("2026-08-03T00:00:00.000Z");
  db.EtsyOrder.aggregate.mockResolvedValue([
    {
      _id: { sellerId: "68b93ed3f02eed8dec002ee6", sellerName: "Nguyễn Đức Sơn", day },
      items: 1,
      revenue: 60.41,
      baseCost: 54.49,
      refund: 0,
      shipping_tax: 0,
      item_promotion_discount: 0,
      item_tax: 0,
    },
    {
      _id: { sellerId: "68b93ed3f02eed8dec002eee", sellerName: "Nguyễn Minh Đức", day },
      items: 1,
      revenue: 36.53,
      baseCost: 14.84,
      refund: 0,
      shipping_tax: 0,
      item_promotion_discount: 0,
      item_tax: 0,
    },
  ]);
  db.EtsyAdsDailySummary.find.mockReturnValue(chain());
  db.user.find.mockReturnValue(chain());

  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  await controller.getEtsyReportMatrix({
    query: { from: "2026-08-03T00:00:00.000Z", to: "2026-08-03T23:59:59.999Z" },
    user: { role: "Admin" },
  }, res);

  const { data } = res.json.mock.calls[0][0];
  expect(data["Nguyễn Đức Sơn"].totals).toMatchObject({ items: 1, revenue: 60.41, baseCost: 54.49, fee: 12.99, profit1: -7.07 });
  expect(data["Nguyễn Minh Đức"].totals).toMatchObject({ items: 1, revenue: 36.53, baseCost: 14.84, fee: 7.85, profit1: 13.84 });
  expect(data["Nguyễn Đức Sơn"].totals.revenue + data["Nguyễn Minh Đức"].totals.revenue).toBe(96.94);
});
