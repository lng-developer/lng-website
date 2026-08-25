const OrderHistory = require("../orderHistory.model");

test("expires order history after 180 days", () => {
  expect(OrderHistory.schema.indexes()).toEqual(
    expect.arrayContaining([
      [{ createdAt: 1 }, expect.objectContaining({ expireAfterSeconds: 180 * 24 * 60 * 60 })],
    ])
  );
});
