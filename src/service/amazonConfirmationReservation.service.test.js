const {
  finalizeAmazonConfirmation,
  markAmazonConfirmationSubmitted,
  releaseAmazonConfirmationReservation,
  reserveAmazonConfirmation,
} = require("./amazonConfirmationReservation.service");

const INPUT = {
  orderId: "112-0319169-1534648",
  shopId: "shop-1",
  batchId: "batch-1",
  now: new Date("2026-09-25T12:00:00.000Z"),
};

function orderModel() {
  return {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  };
}

describe("Amazon confirmation reservation", () => {
  test("allows only one concurrent reservation for the same shop order", async () => {
    const OrderModel = orderModel();
    OrderModel.findOneAndUpdate
      .mockResolvedValueOnce({ orderId: INPUT.orderId })
      .mockResolvedValueOnce(null);

    const [first, second] = await Promise.all([
      reserveAmazonConfirmation({ OrderModel, ...INPUT }),
      reserveAmazonConfirmation({ OrderModel, ...INPUT, batchId: "batch-2" }),
    ]);

    expect(first).toEqual({ reserved: true, order: { orderId: INPUT.orderId } });
    expect(second).toEqual({ reserved: false, order: null });
    expect(OrderModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: INPUT.orderId,
        shopId: INPUT.shopId,
        $or: [
          { "amazonConfirmation.state": { $exists: false } },
          { "amazonConfirmation.state": null },
        ],
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "amazonConfirmation.state": "reserved",
          "amazonConfirmation.batchId": INPUT.batchId,
          "amazonConfirmation.reservedAt": INPUT.now,
        }),
      }),
      { new: true },
    );
  });

  test("releases only its own unsubmitted reservation", async () => {
    const OrderModel = orderModel();
    OrderModel.updateOne.mockResolvedValueOnce({ modifiedCount: 1 }).mockResolvedValueOnce({ modifiedCount: 0 });

    await expect(releaseAmazonConfirmationReservation({ OrderModel, ...INPUT })).resolves.toBe(true);
    await expect(releaseAmazonConfirmationReservation({ OrderModel, ...INPUT, batchId: "other-batch" })).resolves.toBe(false);
    expect(OrderModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: INPUT.orderId,
        shopId: INPUT.shopId,
        "amazonConfirmation.batchId": INPUT.batchId,
        "amazonConfirmation.state": "reserved",
      }),
      { $unset: { amazonConfirmation: 1 } },
    );
  });

  test("moves only an owned reservation to submitted", async () => {
    const OrderModel = orderModel();
    OrderModel.findOneAndUpdate.mockResolvedValueOnce({ orderId: INPUT.orderId }).mockResolvedValueOnce(null);

    await expect(markAmazonConfirmationSubmitted({ OrderModel, ...INPUT })).resolves.toEqual({ submitted: true, order: { orderId: INPUT.orderId } });
    await expect(markAmazonConfirmationSubmitted({ OrderModel, ...INPUT, batchId: "other-batch" })).resolves.toEqual({ submitted: false, order: null });
    expect(OrderModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "amazonConfirmation.batchId": INPUT.batchId,
        "amazonConfirmation.state": "reserved",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "amazonConfirmation.state": "submitted",
          "amazonConfirmation.submittedAt": INPUT.now,
        }),
      }),
      { new: true },
    );
  });

  test("does not overwrite terminal confirmation states", async () => {
    const OrderModel = orderModel();
    OrderModel.findOneAndUpdate.mockResolvedValueOnce({ orderId: INPUT.orderId }).mockResolvedValueOnce(null);

    await expect(finalizeAmazonConfirmation({ OrderModel, ...INPUT, state: "confirmed", amazonBatchId: "93709020720" })).resolves.toEqual({ finalized: true, order: { orderId: INPUT.orderId } });
    await expect(finalizeAmazonConfirmation({ OrderModel, ...INPUT, state: "failed" })).resolves.toEqual({ finalized: false, order: null });
    expect(OrderModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "amazonConfirmation.batchId": INPUT.batchId,
        "amazonConfirmation.state": "submitted",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "amazonConfirmation.state": "confirmed",
          "amazonConfirmation.amazonBatchId": "93709020720",
          "amazonConfirmation.finalizedAt": INPUT.now,
        }),
      }),
      { new: true },
    );
  });

  test("rejects an unrecognized terminal state before touching the order", async () => {
    const OrderModel = orderModel();

    await expect(finalizeAmazonConfirmation({ OrderModel, ...INPUT, state: "reserved" })).rejects.toThrow("Invalid Amazon confirmation terminal state");
    expect(OrderModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
