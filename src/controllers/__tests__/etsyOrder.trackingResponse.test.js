const {
  buildEtsyTrackingInfoResponse,
  buildEtsyTrackingSummary,
} = require("../../service/etsyTrackingResponse.service");

describe("etsyOrder tracking response helpers", () => {
  const order = {
    orderId: "4078447708",
    vendor_submissions: {
      onos: {
        external_id: "MX-18985-69156",
        tracking_status: "In Production",
        tracking_last_response: {
          detail: {
            data: {
              id: "MX-18985-69156",
              status: "In Production",
              tracking: {
                tracking: "9214490411384200030100",
                carrier: "USPS",
                url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9214490411384200030100",
                shipping_label: "https://cdn.onosexpress.com/label.pdf",
              },
              shipment_id: "06-26-10134609",
              production_at: "2026-06-10T11:42:33.692Z",
              paid_at: "2026-06-10T11:42:28.000Z",
            },
          },
        },
      },
    },
  };

  test("builds FE-friendly Onos tracking summary from vendor submission", () => {
    const item = {
      tracking_info: {
        fulfillment: "Onos",
        tracking: "[object Object]",
        status: "Shipped",
        updated_at: "2026-06-10T12:00:05.581Z",
      },
    };

    expect(buildEtsyTrackingSummary(order, item)).toEqual({
      vendor: "onos",
      fulfillment: "Onos",
      status: "Shipped",
      trackingNumber: "9214490411384200030100",
      carrier: "USPS",
      trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9214490411384200030100",
      shippingLabel: "https://cdn.onosexpress.com/label.pdf",
      vendorStatus: "In Production",
      externalOrderId: "MX-18985-69156",
      shipmentId: "06-26-10134609",
      productionAt: "2026-06-10T11:42:33.692Z",
      paidAt: "2026-06-10T11:42:28.000Z",
      updatedAt: "2026-06-10T12:00:05.581Z",
    });
  });

  test("normalizes tracking_info.tracking for existing bad Onos rows", () => {
    const item = {
      tracking_info: {
        fulfillment: "Onos",
        tracking: "[object Object]",
        status: "Shipped",
      },
    };

    expect(buildEtsyTrackingInfoResponse(order, item)).toEqual(
      expect.objectContaining({
        fulfillment: "Onos",
        tracking: "9214490411384200030100",
        status: "Shipped",
        note: "carrier:USPS",
      })
    );
  });
});
