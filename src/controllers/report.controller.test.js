jest.mock("mongoose", () => ({
  Types: { ObjectId: { isValid: jest.fn(() => true) } },
  connection: {
    collection: jest.fn(() => ({
      aggregate: jest.fn(() => ({
        toArray: jest.fn().mockResolvedValue([
          { orders: 1, revenue: 100, profit: 40, lngCost: 0, vendorCost: 30, diff: 0, refund: 0, tax: 8 },
        ]),
      })),
    })),
  },
}));

jest.mock("../models", () => ({
  orderCustomProduct: {},
  Ads: { find: jest.fn() },
  user: {},
  shop: {},
  Team: {},
}));

const db = require("../models");
const { getOrderCostStatistics } = require("./report.controller");

test("returns total Ads spend for the selected Orders Cost date range", async () => {
  db.Ads.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue([
      { total_spend: 12.5 },
      { total_spend: 7.5 },
    ]),
  });
  const res = { json: jest.fn(), status: jest.fn(function status() { return this; }) };

  await getOrderCostStatistics({ query: { from: "2026-10-01", to: "2026-10-02" }, user: { role: "Admin" } }, res);

  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ads: 20 }));
});
