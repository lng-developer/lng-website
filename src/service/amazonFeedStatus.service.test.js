const { applyAmazonFeedStatus } = require("./amazonFeedStatus.service");

function makeBatch(overrides = {}) {
  return {
    _id: "batch-1",
    machineId: "machine-1",
    shopId: "shop-1",
    completed: [{ orderId: "112-0319169-1534648" }],
    amazonFeed: {},
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("applyAmazonFeedStatus", () => {
  test("rejects an event from a different extension machine", async () => {
    const ShippingBatch = { findById: jest.fn().mockResolvedValue(makeBatch()) };

    await expect(applyAmazonFeedStatus({
      ShippingBatch,
      batchId: "batch-1",
      machineId: "machine-forged",
      event: { status: "processing", amazonBatchId: "93703020720" },
    })).rejects.toMatchObject({ code: "MACHINE_MISMATCH" });
  });

  test("stores a terminal report from the owning machine", async () => {
    const batch = makeBatch();
    const ShippingBatch = { findById: jest.fn().mockResolvedValue(batch) };
    const OrderModel = { findOneAndUpdate: jest.fn().mockResolvedValue({ orderId: "112-0319169-1534648" }) };

    const result = await applyAmazonFeedStatus({
      ShippingBatch,
      OrderModel,
      batchId: "batch-1",
      machineId: "machine-1",
      event: {
        status: "done",
        amazonBatchId: "93703020720",
        recordsProcessed: 1,
        recordsActivated: 1,
        errorCount: 0,
        warningCount: 0,
        reportText: "Number of records that were activated: 1",
      },
    });

    expect(result.status).toBe("done");
    expect(result.terminal).toBe(true);
    expect(batch.amazonFeed.amazonBatchId).toBe("93703020720");
    expect(batch.save).toHaveBeenCalledTimes(1);
    expect(OrderModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "112-0319169-1534648",
        shopId: "shop-1",
        "amazonConfirmation.batchId": "batch-1",
        "amazonConfirmation.state": "submitted",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ "amazonConfirmation.state": "confirmed" }),
      }),
      { new: true },
    );
  });
});
