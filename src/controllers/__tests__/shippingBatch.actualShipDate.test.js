const controller = require("../shippingBatch.contrller");

describe("actual ship date eligibility", () => {
  test("blocks tracking without a carrier-proven ship date", () => {
    const shipment = controller._test.getOrderShipmentSnapshot({
      items: [
        {
          orderItemId: "i1",
          quantity: 1,
          tracking_info: { tracking: "921", carrier: "USPS" },
        },
      ],
    });

    expect(shipment.bulkBlockReason).toBe("MISSING_ACTUAL_SHIP_DATE");
  });

  test("uses the Los Angeles date from the carrier handoff timestamp", () => {
    const shipment = controller._test.getOrderShipmentSnapshot({
      shipByDate: new Date("2026-09-20T07:00:00.000Z"),
      items: [
        {
          orderItemId: "i1",
          quantity: 1,
          tracking_info: {
            tracking: "921",
            carrier: "USPS",
            actualShipAt: new Date("2026-09-19T01:20:23.000Z"),
          },
        },
      ],
    });

    expect(shipment.bulkConfirmEligible).toBe(true);
    expect(shipment.eligibility).toMatchObject({
      readyForReview: true,
      shipDate: "2026-09-18",
      reasons: [],
    });
    expect(shipment.trackingInfo.actualShipAt.toISOString()).toBe(
      "2026-09-19T01:20:23.000Z",
    );
  });
});
