const { backfillEtsyFees } = require("../backfill-etsy-fees");

const order = {
  _id: "order-object-id",
  orderId: "4067362471",
  totals: { orderTotal: 53.38, salesTax: 3.02, fee: 0 },
};

const makeCollection = () => ({
  find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([order]) }),
  bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
});

test("dry-run reports changes without writing", async () => {
  const collection = makeCollection();

  await expect(backfillEtsyFees({
    collection,
    logger: jest.fn(),
  })).resolves.toEqual({ matched: 1, changed: 1, written: 0 });
  expect(collection.bulkWrite).not.toHaveBeenCalled();
});

test("apply writes only the calculated fee", async () => {
  const collection = makeCollection();

  await expect(backfillEtsyFees({
    collection,
    apply: true,
    logger: jest.fn(),
  })).resolves.toEqual({ matched: 1, changed: 1, written: 1 });
  expect(collection.bulkWrite).toHaveBeenCalledWith([{
    updateOne: {
      filter: { _id: "order-object-id" },
      update: { $set: { "totals.fee": 6.74 } },
    },
  }]);
});
