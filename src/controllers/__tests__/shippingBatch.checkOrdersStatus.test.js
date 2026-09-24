const controller = require("../shippingBatch.contrller");

describe("buildCheckOrdersQuery", () => {
  test("includes every active shipping status by default", () => {
    expect(controller._test.buildCheckOrdersQuery("shop-1").status.$in).toEqual([
      "New", "Fulfilled", "Shipping", "Shipped",
    ]);
  });

  test("blocks a bulk confirmation when items use different tracking numbers", () => {
    const shipment = controller._test.getOrderShipmentSnapshot({
      status: "Shipped",
      items: [
        { orderItemId: "item-1", quantity: 1, tracking_info: { tracking: "TRACK-A", carrier: "USPS" } },
        { orderItemId: "item-2", quantity: 1, tracking_info: { tracking: "TRACK-B", carrier: "USPS" } },
      ],
    });

    expect(shipment).toMatchObject({
      isSplitShipment: true,
      bulkConfirmEligible: false,
      bulkBlockReason: "SPLIT_SHIPMENT",
      trackingCount: 2,
    });
  });

  test("blocks a bulk confirmation when a real tracking has no vendor carrier", () => {
    const shipment = controller._test.getOrderShipmentSnapshot({
      status: "Shipped",
      items: [{ orderItemId: "item-1", quantity: 1, tracking_info: { tracking: "TRACK-A" } }],
    });

    expect(shipment).toMatchObject({
      hasTracking: true,
      bulkConfirmEligible: false,
      bulkBlockReason: "MISSING_CARRIER",
    });
  });

  test("blocks a buyer-requested cancellation even when tracking is complete", () => {
    const shipment = controller._test.getOrderShipmentSnapshot({
      status: "Shipped",
      buyerRequestedCancellation: true,
      items: [{ orderItemId: "item-1", quantity: 1, tracking_info: { tracking: "TRACK-A", carrier: "USPS" } }],
    });

    expect(shipment).toMatchObject({ bulkConfirmEligible: false, bulkBlockReason: "BUYER_CANCELLATION" });
  });

  test("searches the whole selected shop by escaped order/tracking text", () => {
    const query = controller._test.buildCheckOrdersQuery("shop-1", {
      search: "111-123.*",
      tracking: "yes",
      fromDate: "2026-09-01",
      toDate: "2026-09-24",
    });

    expect(query).toMatchObject({
      shopId: "shop-1",
      $or: [
        { orderId: { $regex: "111-123\\.\\*", $options: "i" } },
        { "items.tracking_info.tracking": { $regex: "111-123\\.\\*", $options: "i" } },
      ],
      items: {
        $elemMatch: {
          "tracking_info.tracking": { $regex: "^(?!-+$).*\\S" },
        },
      },
      createdAt: {
        $gte: new Date("2026-09-01T00:00:00.000Z"),
        $lt: new Date("2026-09-25T00:00:00.000Z"),
      },
    });
  });
});
