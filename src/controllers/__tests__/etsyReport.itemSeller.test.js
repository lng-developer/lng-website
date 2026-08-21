jest.mock("../../models", () => ({
  EtsyOrder: { aggregate: jest.fn() },
  EtsyAdsDailySummary: { find: jest.fn() },
  user: { find: jest.fn() },
  Team: { findById: jest.fn() },
}));

const db = require("../../models");
const controller = require("../etsyReport.controller");

const chain = (rows = []) => ({ lean: jest.fn().mockResolvedValue(rows) });

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
