jest.mock("../../models", () => ({
  shop: { find: jest.fn() },
  RealtimeLog: { create: jest.fn().mockResolvedValue({}) },
  ExtensionTask: { findOne: jest.fn() },
  orderCustomProduct: { find: jest.fn(), findOne: jest.fn() },
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

const mockAxiosClients = [];
jest.mock("axios", () => ({
  default: {
    create: jest.fn(() => {
      const client = { get: jest.fn(), request: jest.fn() };
      mockAxiosClients.push(client);
      return client;
    }),
  },
}));

jest.mock("../../service/orderLifecycleLogger", () => ({
  logOrderLifecycleEvent: jest.fn().mockResolvedValue(undefined),
}));

const db = require("../../models");
const { logOrderLifecycleEvent } = require("../../service/orderLifecycleLogger");
process.env.MANGOTEE_API_KEY = "test-mangotee-key";
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

function mockCustomOrderFindLean(rows) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  db.orderCustomProduct.find.mockReturnValue(chain);
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
        vendor_submissions: { grabink: { sent: true, sent_at: new Date() } },
        items: [{ cost_breakdown: { vendorProductId: "vp-beeful" } }],
      },
      {
        orderId: "ETSY-2",
        shopId: "6881aba9c1bbdfc541b5cd4d",
        vendor_submissions: { lenful: { sent: true, sent_at: new Date("2020-01-01T00:00:00Z") } },
        items: [{ cost_breakdown: { vendorProductId: "vp-lenful-old" } }],
      },
      {
        orderId: "ETSY-3",
        shopId: "6881aba9c1bbdfc541b5cd4d",
        vendor_submissions: { onos: { sent: true, sent_at: new Date() } },
        items: [{ cost_breakdown: { vendorProductId: "vp-onos" } }],
      },
    ]);
    mockSelectLean(db.vendorProduct.find, [
      { _id: "vp-beeful", vendor_id: "vendor-beeful" },
      { _id: "vp-lenful-old", vendor_id: "vendor-lenful-old" },
      { _id: "vp-onos", vendor_id: "vendor-onos" },
    ]);
    mockSelectLean(db.vendor.find, [
      { _id: "vendor-beeful", name: "Grabink Beeful", fulfillment_type: "Beeful" },
      { _id: "vendor-lenful-old", name: "Lenful", fulfillment_type: "API" },
      { _id: "vendor-onos", name: "OnosPOD", fulfillment_type: "onos" },
    ]);

    const result = await controller.runEtsyVendorBatch({
      max: 10,
      dryRun: true,
      status: "Fulfilled",
    });

    expect(db.EtsyOrder.find).toHaveBeenCalledWith(expect.objectContaining({
      $or: expect.arrayContaining([
        expect.objectContaining({ "vendor_submissions.onos.sent": true }),
        expect.objectContaining({ "vendor_submissions.grabink.sent": true }),
      ]),
      status: "Fulfilled",
    }));
    expect(result).toEqual(expect.objectContaining({
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
    }));
    expect(result.sentAfter).toEqual(expect.any(String));
  });

  test("one-order controller returns not found when Etsy order is missing", async () => {
    db.EtsyOrder.findOne.mockResolvedValue(null);
    const req = { body: { orderId: "ETSY-MISSING" } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await controller.etsyVendorSyncOne(req, res);

    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      orderId: "ETSY-MISSING",
      stage: "TRACKING_PULL",
      eventType: "TRACKING_PULL_FAILED",
      status: "failed",
      reason: "Etsy order not found in DB: ETSY-MISSING",
    }));
    expect(db.EtsyOrder.findOne).toHaveBeenCalledWith({ orderId: "ETSY-MISSING" });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      message: "Etsy order not found in DB: ETSY-MISSING",
    });
  });

  test("dry-run batch includes Lenful vendor mappings", async () => {
    mockOrderFindLean([
      {
        orderId: "ETSY-LENFUL",
        shopId: "6881aba9c1bbdfc541b5cd4d",
        vendor_submissions: { lenful: { sent: true, sent_at: new Date() } },
        items: [{ cost_breakdown: { vendorProductId: "vp-lenful" } }],
      },
    ]);
    mockSelectLean(db.vendorProduct.find, [
      { _id: "vp-lenful", vendor_id: "vendor-lenful" },
    ]);
    mockSelectLean(db.vendor.find, [
      { _id: "vendor-lenful", name: "Lenful", fulfillment_type: "API" },
    ]);

    const result = await controller.runEtsyVendorBatch({
      max: 10,
      dryRun: true,
      status: "Fulfilled",
    });

    expect(result.vendorsPerOrder).toEqual([
      {
        orderId: "ETSY-LENFUL",
        shopId: "6881aba9c1bbdfc541b5cd4d",
        vendorKeys: ["lenful"],
      },
    ]);
  });

  test("custom-product dry-run batch includes Lenful vendor mappings", async () => {
    mockCustomOrderFindLean([
      {
        orderId: "111-9039002-8646662",
        vendor_submissions: { lenful: { sent: true, sent_at: new Date() } },
        items: [{ cost_breakdown: { vendorProductId: "vp-lenful" } }],
      },
    ]);
    mockSelectLean(db.vendorProduct.find, [
      { _id: "vp-lenful", vendor_id: "vendor-lenful" },
    ]);
    mockSelectLean(db.vendor.find, [
      { _id: "vendor-lenful", name: "Lenful", fulfillment_type: "API" },
    ]);

    const result = await controller.runBatch({
      max: 10,
      dryRun: true,
    });

    expect(result.vendorsPerOrder).toEqual([
      {
        orderId: "111-9039002-8646662",
        vendorKeys: ["lenful"],
      },
    ]);
  });

  test("custom-product Lenful sync surfaces token errors without saving", async () => {
    const save = jest.fn();
    db.orderCustomProduct.findOne.mockResolvedValue({
      orderId: "111-9039002-8646662",
      status: "Fulfilled",
      vendor_submissions: { lenful: { sent: true } },
      items: [
        {
          cost_breakdown: { vendorProductId: "vp-lenful" },
          tracking_info: { status: "New", tracking: "" },
        },
      ],
      save,
    });

    await expect(
      controller.updateOrderByVendors(
        "111-9039002-8646662",
        new Map([["vp-lenful", { vendorKey: "lenful", vendorName: "Lenful" }]])
      )
    ).rejects.toThrow("Lenful missing API key");

    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "amazon",
      orderId: "111-9039002-8646662",
      stage: "TRACKING_PULL",
      eventType: "TRACKING_PULL_FAILED",
      status: "failed",
      reason: expect.stringContaining("Lenful missing API key"),
    }));
    expect(save).not.toHaveBeenCalled();
  });

  test("custom-product non-critical empty tracking does not log no-op lifecycle events", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    db.orderCustomProduct.findOne.mockResolvedValue({
      orderId: "111-9039002-8646662",
      status: "Fulfilled",
      vendor_submissions: { merchize: { sent: true } },
      items: [
        {
          cost_breakdown: { vendorProductId: "vp-merchize" },
          tracking_info: { status: "New", tracking: "" },
        },
      ],
      save,
    });
    mockAxiosClients[2].get
      .mockResolvedValueOnce({ status: 200, data: { success: true, data: [] } })
      .mockResolvedValueOnce({ status: 200, data: { success: true, data: [] } });

    const result = await controller.updateOrderByVendors(
      "111-9039002-8646662",
      new Map([["vp-merchize", { vendorKey: "merchize", vendorName: "Merchize" }]])
    );

    expect(result).toEqual({ updatedItems: 0, orderStatusChanged: false });
    expect(logOrderLifecycleEvent).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test("custom-product sync pulls only the vendor that was actually sent", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    db.orderCustomProduct.findOne.mockResolvedValue({
      orderId: "111-9039002-8646662",
      status: "Fulfilled",
      vendor_submissions: { printway: { sent: true, external_id: "PW-1" } },
      items: [
        {
          cost_breakdown: { vendorProductId: "vp-mangotee" },
          tracking_info: { status: "New", tracking: "" },
        },
      ],
      save,
    });
    mockAxiosClients[3].request.mockResolvedValueOnce({
      status: 200,
      data: JSON.stringify({
        data: {
          order_name: "111-9039002-8646662",
          trackings: [
            {
              trackingNumber: "9214490411387004216060",
              carrierName: "USPS",
              updatedAt: "2026-06-28T00:00:00Z",
            },
          ],
        },
      }),
    });

    const result = await controller.updateOrderByVendors(
      "111-9039002-8646662",
      new Map([["vp-mangotee", { vendorKey: "mangotee", vendorName: "MangoTee" }]])
    );

    expect(result).toEqual({ updatedItems: 1, orderStatusChanged: true });
    expect(mockAxiosClients[3].request).toHaveBeenCalled();
    expect(mockAxiosClients[4].get).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });

  test("custom-product MangoTee ORDER_NOT_FOUND does not log failed lifecycle event", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    db.orderCustomProduct.findOne.mockResolvedValue({
      orderId: "112-1784082-5908235",
      status: "Fulfilled",
      vendor_submissions: { mangotee: { sent: true } },
      items: [
        {
          cost_breakdown: { vendorProductId: "vp-mangotee" },
          tracking_info: { status: "New", tracking: "" },
        },
      ],
      save,
    });
    mockAxiosClients[4].get.mockResolvedValueOnce({
      status: 200,
      data: { status: false, code: "ORDER_NOT_FOUND" },
    });

    const result = await controller.updateOrderByVendors(
      "112-1784082-5908235",
      new Map([["vp-mangotee", { vendorKey: "mangotee", vendorName: "MangoTee" }]])
    );

    expect(result).toEqual({ updatedItems: 0, orderStatusChanged: false });
    expect(logOrderLifecycleEvent).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
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

  test("picks exact Lenful tracking row and ignores near matches", () => {
    const result = controller.pickLenfulTracking(
      {
        data: [
          {
            order_number: "111-9039002-8646662-X",
            order_short_id: "wrong",
            company: "UPS",
            number: "NEARMATCH123456",
            status: "Shipped",
          },
          {
            order_number: "111-9039002-8646662",
            order_short_id: "hO4nh2062426",
            company: "",
            translation: { name: "USPS" },
            number: "9214490411387004216060",
            status: "NoActive",
          },
        ],
      },
      "111-9039002-8646662",
      {}
    );

    expect(result).toEqual({
      tracking: "9214490411387004216060",
      carrier: "USPS",
      shipped: true,
      raw: expect.objectContaining({
        order_number: "111-9039002-8646662",
      }),
    });
  });

  test("picks Lenful tracking by external id fallback", () => {
    const result = controller.pickLenfulTracking(
      {
        data: [
          {
            order_number: "LF-ORDER",
            order_short_id: "short-123",
            company: "USPS",
            number: "9214490411387004216060",
          },
        ],
      },
      "111-9039002-8646662",
      { vendor_submissions: { lenful: { external_id: "short-123" } } }
    );

    expect(result.tracking).toBe("9214490411387004216060");
    expect(result.carrier).toBe("USPS");
  });

  test("rejects Lenful tracking payload without an exact order match", () => {
    expect(() =>
      controller.pickLenfulTracking(
        {
          data: [
            {
              order_number: "111-9039002-8646662-X",
              order_short_id: "wrong",
              company: "UPS",
              number: "NEARMATCH123456",
            },
          ],
        },
        "111-9039002-8646662",
        {}
      )
    ).toThrow("Lenful tracking not found for 111-9039002-8646662");
  });
});
