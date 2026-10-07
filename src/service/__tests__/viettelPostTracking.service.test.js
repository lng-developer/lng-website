const {
  buildTrackingSync,
  matchesShipmentTracking,
  applyTrackingSync,
  trackingLookupValues,
  recentShipments,
} = require("../viettelPostTracking.service");

test("matches an Epacket tracking number to its USPS suffix", () => {
  expect(matchesShipmentTracking("4203005271079214490374008504625052", "9214490374008504625052")).toBe(true);
  expect(matchesShipmentTracking("4203005271079214490374008504625052", "9214490374008504625053")).toBe(false);
});

test("creates exact lookup values for Epacket tracking suffixes", () => {
  expect(trackingLookupValues(["4203005271079214490374008504625052"])).toEqual(
    expect.arrayContaining(["4203005271079214490374008504625052", "9214490374008504625052"])
  );
});

test("keeps only Epacket shipments created inside the requested sync window", () => {
  const since = new Date("2026-10-01T00:00:00.000Z");
  expect(recentShipments([
    { shipmentCode: "inside", dateCreate: "2026-10-01T00:00:00.000Z" },
    { shipmentCode: "outside", dateCreate: "2026-09-30T23:59:59.999Z" },
  ], since).map((shipment) => shipment.shipmentCode)).toEqual(["inside"]);
});

test("uses the first post-office acceptance event as carrier handoff", () => {
  const result = buildTrackingSync(
    { id: "shipment-1", shipmentCode: "EPK1", trackingNumber: "4203005271079214490374008504625052", shipBy: "usps" },
    {
      activitiesTimeline: [
        { dateCreate: "2026-10-06T04:29:55.103Z", activity: "Shipping Label Created, USPS Awaiting Item" },
        { code: 200, dateCreate: "2026-10-06T11:02:23.514Z", activity: "200 - Enter revenue from the post office." },
      ],
    }
  );

  expect(result).toEqual({
    carrier: "USPS",
    shipmentId: "shipment-1",
    shipmentCode: "EPK1",
    tracking: "4203005271079214490374008504625052",
    actualShipAt: new Date("2026-10-06T11:02:23.514Z"),
    shipEvidence: {
      provider: "viettelpost",
      activityCode: 200,
      activity: "200 - Enter revenue from the post office.",
      eventAt: "2026-10-06T11:02:23.514Z",
    },
  });
});

test("does not treat a USPS label as carrier handoff", () => {
  const result = buildTrackingSync(
    { id: "shipment-1", shipmentCode: "EPK1", trackingNumber: "4203005271079214490374008504625052", shipBy: "usps" },
    { activitiesTimeline: [{ dateCreate: "2026-10-06T04:29:55.103Z", activity: "Shipping Label Created, USPS Awaiting Item" }] }
  );

  expect(result.actualShipAt).toBeNull();
  expect(result.shipEvidence).toBeNull();
});

test("updates only the matching item while preserving its existing tracking number", () => {
  const order = {
    items: [
      { orderItemId: "match", tracking_info: { tracking: "9214490374008504625052", status: "Shipped" } },
      { orderItemId: "other", tracking_info: { tracking: "OTHER12345678", status: "Shipped" } },
    ],
    vendor_submissions: {},
  };

  const result = applyTrackingSync(order, {
    shipmentId: "shipment-1",
    shipmentCode: "EPK1",
    tracking: "4203005271079214490374008504625052",
    carrier: "USPS",
    actualShipAt: new Date("2026-10-06T11:02:23.514Z"),
    shipEvidence: { provider: "viettelpost", activityCode: 200 },
  }, new Date("2026-10-07T00:00:00.000Z"));

  expect(result).toEqual({ changedItems: 1, matchedItems: 1, changed: true });
  expect(order.items[0].tracking_info).toMatchObject({
    tracking: "9214490374008504625052",
    carrier: "USPS",
    actualShipAt: new Date("2026-10-06T11:02:23.514Z"),
  });
  expect(order.items[1].tracking_info.carrier).toBeUndefined();
  expect(order.vendor_submissions.viettelpost).toMatchObject({
    external_id: "shipment-1",
    shipment_code: "EPK1",
  });
});

test("does not replace an existing carrier handoff with a later Epacket sync", () => {
  const order = {
    items: [{ tracking_info: { tracking: "9214490374008504625052", carrier: "USPS", actualShipAt: new Date("2026-10-05T00:00:00.000Z") } }],
    vendor_submissions: { viettelpost: { external_id: "shipment-1", shipment_code: "EPK1", tracking: "4203005271079214490374008504625052", carrier: "USPS", actual_ship_at: new Date("2026-10-05T00:00:00.000Z") } },
  };

  const result = applyTrackingSync(order, {
    shipmentId: "shipment-1",
    shipmentCode: "EPK1",
    tracking: "4203005271079214490374008504625052",
    carrier: "UPS",
    actualShipAt: new Date("2026-10-06T11:02:23.514Z"),
    shipEvidence: { provider: "viettelpost", activityCode: 200 },
  }, new Date("2026-10-07T00:00:00.000Z"));

  expect(result.changed).toBe(false);
  expect(order.items[0].tracking_info.carrier).toBe("USPS");
  expect(order.items[0].tracking_info.actualShipAt).toEqual(new Date("2026-10-05T00:00:00.000Z"));
});
