const controller = require("../orderCustomProduct.controller");

test("maps Amazon report ship deadline and cancellation metadata", () => {
  const metadata = controller._test.amazonOrderMetadataFromRow({
    latest_ship_date: "2026-09-24T23:59:59-07:00",
    earliest_ship_date: "2026-09-24T00:00:00-07:00",
    is_buyer_requested_cancellation: "true",
    buyer_requested_cancel_reason: "Buyer changed their mind",
  });

  expect(metadata.shipByDate.toISOString()).toBe("2026-09-25T06:59:59.000Z");
  expect(metadata.earliestShipDate.toISOString()).toBe("2026-09-24T07:00:00.000Z");
  expect(metadata.buyerRequestedCancellation).toBe(true);
  expect(metadata.buyerRequestedCancelReason).toBe("Buyer changed their mind");
});

test("keeps existing ship deadlines when a later import row omits them", () => {
  const order = {
    shipByDate: new Date("2026-10-03T06:59:59.000Z"),
    earliestShipDate: new Date("2026-10-01T07:00:00.000Z"),
  };

  controller._test.applyAmazonOrderMetadata(order, {
    is_buyer_requested_cancellation: "false",
  });

  expect(order.shipByDate.toISOString()).toBe("2026-10-03T06:59:59.000Z");
  expect(order.earliestShipDate.toISOString()).toBe("2026-10-01T07:00:00.000Z");
});

test("accepts only bounded callback tracking metadata", () => {
  expect(controller._test.normalizeTrackingCallbackField(" USPS ", "carrier")).toBe("USPS");
  expect(controller._test.normalizeTrackingCallbackField(undefined, "carrier")).toBe("");
  expect(() => controller._test.normalizeTrackingCallbackField(123, "carrier")).toThrow("carrier must be a string");
});
