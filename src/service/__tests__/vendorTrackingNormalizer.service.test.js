const {
  normalizeVendorSubmissionTracking,
  normalizeVendorTrackingPayload,
  resolveCarrierAcceptanceEvent,
} = require("../vendorTrackingNormalizer.service");

describe("vendorTrackingNormalizer", () => {
  test("normalizes nested Onos tracking payload", () => {
    const result = normalizeVendorTrackingPayload("onos", {
      status: true,
      data: {
        id: "MX-18985-69156",
        referent_id: "4078447708",
        status: "In Production",
        tracking: {
          tracking: "9214490411384200030100",
          carrier: "USPS",
          url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9214490411384200030100",
          shipping_label: "https://cdn.onosexpress.com/label.pdf",
        },
        shipment_id: "06-26-10134609",
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        provider: "onos",
        fulfillment: "Onos",
        externalOrderId: "MX-18985-69156",
        orderId: "4078447708",
        trackingNumber: "9214490411384200030100",
        carrier: "USPS",
        trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9214490411384200030100",
        shippingLabel: "https://cdn.onosexpress.com/label.pdf",
        shipmentId: "06-26-10134609",
        shipped: true,
      })
    );
  });

  test("normalizes generic vendor payload with a different tracking shape", () => {
    const result = normalizeVendorTrackingPayload("new-vendor", {
      data: {
        external_id: "VN-1001",
        orderId: "ORDER-1001",
        fulfillment_status: "fulfilled",
        shipments: [
          {
            tracking_code: "NV123456789US",
            shipping_provider: "DHL",
            tracking_url: "https://tracking.example/NV123456789US",
            label_url: "https://label.example/NV123456789US.pdf",
            updated_at: "2026-06-11T03:15:00.000Z",
          },
        ],
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        provider: "new-vendor",
        externalOrderId: "VN-1001",
        orderId: "ORDER-1001",
        trackingNumber: "NV123456789US",
        carrier: "DHL",
        trackingUrl: "https://tracking.example/NV123456789US",
        shippingLabel: "https://label.example/NV123456789US.pdf",
        status: "fulfilled",
        shipped: true,
      })
    );
  });

  test("normalizes Onos order wrapper webhook payload", () => {
    const result = normalizeVendorTrackingPayload("onos", {
      order: {
        id: "HQ-95254-44106",
        order_id: "4078286134",
        referent_id: "4078286134",
        status: "Cancelled",
        tracking: {
          tracking: "",
          carrier: "",
          url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=%2C",
          shipping_label: "",
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        provider: "onos",
        externalOrderId: "HQ-95254-44106",
        orderId: "4078286134",
        status: "cancelled",
        trackingNumber: "",
        shipped: false,
      })
    );
  });

  test("normalizes tracking from stored vendor submission", () => {
    const result = normalizeVendorSubmissionTracking("onos", {
      external_id: "MX-18985-69156",
      tracking_status: "In Production",
      tracking_last_response: {
        detail: {
          data: {
            tracking: {
              tracking: "9214490411384200030100",
              carrier: "USPS",
            },
          },
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        provider: "onos",
        externalOrderId: "MX-18985-69156",
        vendorStatus: "In Production",
        trackingNumber: "9214490411384200030100",
        carrier: "USPS",
      })
    );
  });

  test("uses the first carrier-acceptance event from MerchFox", () => {
    const result = resolveCarrierAcceptanceEvent("merchfox", {
      tracking: {
        events: [
          { description: "Shipping Label Created", time_utc: "2026-09-22T15:45:07Z" },
          { description: "Accepted at USPS Facility", location: "RICHARDSON, TX, US", time_utc: "2026-09-22T16:54:56Z" },
        ],
      },
    });

    expect(result.actualShipAt.toISOString()).toBe("2026-09-22T16:54:56.000Z");
    expect(result.shipEvidence).toEqual(expect.objectContaining({ provider: "merchfox", event: "Accepted at USPS Facility" }));
  });

  test("uses Lenful acceptance event and ignores label creation", () => {
    const result = resolveCarrierAcceptanceEvent("lenful", {
      tracking: {
        events: [
          { status: "Shipping Label Created", datetime: "2026-09-07T13:28:51Z" },
          { status: "Accepted at USPS Facility", datetime: "2026-09-09T03:05:19Z" },
        ],
      },
    });

    expect(result.actualShipAt.toISOString()).toBe("2026-09-09T03:05:19.000Z");
    expect(resolveCarrierAcceptanceEvent("merchize", { tracking_number: "9214" })).toBeNull();
  });
});
