jest.mock("../../models", () => ({
  orderCustomProduct: { aggregate: jest.fn() },
  Ads: { find: jest.fn() },
  user: { find: jest.fn() },
  shop: {},
  Team: { findById: jest.fn(), find: jest.fn() },
}));

const db = require("../../models");
const controller = require("../report.controller");

const chain = (rows = []) => ({ lean: jest.fn().mockResolvedValue(rows) });

test("does not charge opCost on a seller's inactive date", async () => {
  const sellerId = "68b93ed3f02eed8dec002eee";
  const day = new Date("2026-08-10T04:00:00.000Z");
  db.orderCustomProduct.aggregate.mockResolvedValue([
    {
      _id: { sellerId, sellerName: "Inactive seller", day },
      items: 1,
      revenue: 100,
      baseCost: 40,
      fee: 15,
      refund: 0,
      shipping_tax: 0,
      item_promotion_discount: 0,
      item_tax: 0,
    },
  ]);
  db.Ads.find.mockReturnValue(chain());
  db.user.find.mockReturnValue(chain([
    { _id: sellerId, start_seller: new Date("2026-08-01"), end_seller: day },
  ]));

  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  await controller.getReportMatrix({
    query: { from: "2026-08-10", to: "2026-08-10" },
    user: { role: "Admin" },
  }, res);

  expect(res.json.mock.calls[0][0].data["Inactive seller"].totals.opCost).toBe(0);
});

test("charges opCost through the selected day for a seller without an end date", async () => {
  const sellerId = "68b93ed3f02eed8dec002eee";
  const day = new Date("2026-08-10T04:00:00.000Z");
  db.orderCustomProduct.aggregate.mockResolvedValue([
    {
      _id: { sellerId, sellerName: "Active seller", day },
      items: 1,
      revenue: 100,
      baseCost: 40,
      fee: 15,
      refund: 0,
      shipping_tax: 0,
      item_promotion_discount: 0,
      item_tax: 0,
    },
  ]);
  db.Ads.find.mockReturnValue(chain());
  db.user.find.mockReturnValue(chain([
    { _id: sellerId, start_seller: new Date("2026-08-01") },
  ]));

  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  await controller.getReportMatrix({
    query: { from: "2026-08-10", to: "2026-08-10" },
    user: { role: "Admin" },
  }, res);

  expect(res.json.mock.calls[0][0].data["Active seller"].totals.opCost).toBe(10);
});
