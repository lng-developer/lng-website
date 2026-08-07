jest.mock("../../models", () => ({
  EtsyOrder: { aggregate: jest.fn() },
  EtsyAdsDailySummary: { find: jest.fn() },
  user: { find: jest.fn() },
  Team: { findById: jest.fn() },
}));

const db = require("../../models");
const { getEtsyReportMatrix } = require("../etsyReport.controller");

test("uses the aggregated Etsy fee instead of 21.5% of revenue", async () => {
  db.EtsyOrder.aggregate.mockResolvedValue([{
    _id: {
      sellerId: null,
      sellerName: "Nguyễn Đức Sơn (Bé)",
      day: new Date("2026-08-07T00:00:00.000Z"),
    },
    items: 2,
    revenue: 40.86,
    fee: 5.26,
    item_tax: 2.31,
    shipping_tax: 0,
    item_promotion_discount: 12.85,
    baseCost: 0,
    refund: 0,
  }]);
  db.EtsyAdsDailySummary.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue([]),
  });

  const req = {
    query: {
      from: "2026-08-07T00:00:00.000Z",
      to: "2026-08-07T23:59:59.999Z",
    },
    user: { role: "admin", userId: "admin" },
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };

  await getEtsyReportMatrix(req, res);

  const seller = res.json.mock.calls[0][0].data["Nguyễn Đức Sơn (Bé)"];
  expect(seller.fee).toEqual([5.26]);
  expect(seller.profit1).toEqual([35.6]);
});
