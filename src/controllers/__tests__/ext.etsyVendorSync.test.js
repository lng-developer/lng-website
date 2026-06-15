jest.mock("../../models", () => ({
  shop: { find: jest.fn() },
  RealtimeLog: { create: jest.fn().mockResolvedValue({}) },
  ExtensionTask: { findOne: jest.fn() },
  orderCustomProduct: {},
  EtsyOrder: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
  vendorProduct: { find: jest.fn() },
  vendor: { find: jest.fn() },
}));

jest.mock("../../lib/taskEmitter", () => ({
  buildTaskId: jest.fn(),
  emitTaskToMachine: jest.fn(),
}));

const db = require("../../models");
const controller = require("../ext.controller");

function mockOrderFindLean(rows) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  db.EtsyOrder.find.mockReturnValue(chain);
  return chain;
}

function mockSelectLean(findMock, rows) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  findMock.mockReturnValue(chain);
  return chain;
}

describe("ext Etsy vendor sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("dry-run batch scans etsyorders and returns only orders with supported vendor mappings", async () => {
    mockOrderFindLean([
      {
        orderId: "ETSY-1",
        shopId: "6881aba9c1bbdfc541b5cd4d",
        items: [{ cost_breakdown: { vendorProductId: "vp-beeful" } }],
      },
      {
        orderId: "ETSY-2",
        shopId: "6881aba9c1bbdfc541b5cd4d",
        items: [{ cost_breakdown: { vendorProductId: "vp-unknown" } }],
      },
      {
        orderId: "ETSY-3",
        shopId: "6881aba9c1bbdfc541b5cd4d",
        items: [{ cost_breakdown: { vendorProductId: "vp-onos" } }],
      },
    ]);
    mockSelectLean(db.vendorProduct.find, [
      { _id: "vp-beeful", vendor_id: "vendor-beeful" },
      { _id: "vp-unknown", vendor_id: "vendor-unknown" },
      { _id: "vp-onos", vendor_id: "vendor-onos" },
    ]);
    mockSelectLean(db.vendor.find, [
      { _id: "vendor-beeful", name: "Grabink Beeful", fulfillment_type: "Beeful" },
      { _id: "vendor-unknown", name: "Other Vendor", fulfillment_type: "Other" },
      { _id: "vendor-onos", name: "OnosPOD", fulfillment_type: "onos" },
    ]);

    const result = await controller.runEtsyVendorBatch({
      max: 10,
      dryRun: true,
      status: "Fulfilled",
    });

    expect(db.EtsyOrder.find).toHaveBeenCalledWith({
      "items.cost_breakdown.vendorProductId": { $exists: true, $ne: null },
      status: "Fulfilled",
    });
    expect(result).toEqual({
      ok: true,
      mode: "dry-run",
      scanned: 2,
      orderIds: ["ETSY-1", "ETSY-3"],
      vendorsPerOrder: [
        {
          orderId: "ETSY-1",
          shopId: "6881aba9c1bbdfc541b5cd4d",
          vendorKeys: ["beeful"],
        },
        {
          orderId: "ETSY-3",
          shopId: "6881aba9c1bbdfc541b5cd4d",
          vendorKeys: ["onos"],
        },
      ],
    });
  });

  test("one-order controller returns not found when Etsy order is missing", async () => {
    db.EtsyOrder.findOne.mockResolvedValue(null);
    const req = { body: { orderId: "ETSY-MISSING" } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await controller.etsyVendorSyncOne(req, res);

    expect(db.EtsyOrder.findOne).toHaveBeenCalledWith({ orderId: "ETSY-MISSING" });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      message: "Etsy order not found in DB: ETSY-MISSING",
    });
  });

  test("parses Onos nested tracking object without stringifying it", () => {
    const result = controller.pickOnosTracking({
      status: true,
      data: {
        id: "MX-1",
        order_id: "ORDER-1",
        status: "In Production",
        tracking: {
          tracking: "9214490411384200030100",
          carrier: "USPS",
          url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9214490411384200030100",
          shipping_label: "https://cdn.onosexpress.com/label.pdf",
        },
        updated_at: "2026-06-10T11:42:33.000Z",
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        tracking: "9214490411384200030100",
        carrier: "USPS",
        shipped: true,
      })
    );
    expect(result.tracking).not.toBe("[object Object]");
  });
});
