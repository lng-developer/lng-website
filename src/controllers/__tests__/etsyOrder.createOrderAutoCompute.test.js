jest.mock("../../models", () => ({
  EtsyOrder: {
    findOne: jest.fn(),
    create: jest.fn(),
    bulkWrite: jest.fn(),
    updateOne: jest.fn(),
  },
  vendorProduct: {
    findById: jest.fn(),
  },
  vendorCostCenter: {
    find: jest.fn(),
  },
  configCostCenter: {
    find: jest.fn(),
  },
  configOptionMapping: {
    find: jest.fn(),
  },
  user: {
    findOne: jest.fn(),
  },
  role: {},
  shop: {},
}));

jest.mock("../../models/etsyListing.model", () => ({}));
jest.mock("../../service/cloudflareR2/r2.service", () => ({
  uploadBufferToR2: jest.fn(),
  uploadFilePathToR2: jest.fn(),
}));
jest.mock("../../service/fulfillment", () => ({
  PROVIDERS: [],
  send: jest.fn(),
}));
jest.mock("../../service/orderHistoryLogger", () => ({
  logOrderHistory: jest.fn(),
}));
jest.mock("../../service/orderLifecycleLogger", () => ({
  logOrderLifecycleEvent: jest.fn(),
}));
jest.mock("../../service/etsyTrackingResponse.service", () => ({
  buildEtsyTrackingInfoResponse: jest.fn(() => ({})),
  buildEtsyTrackingSummary: jest.fn(() => ({})),
}));
jest.mock("../../helper/logger", () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock("axios", () => ({}));

const mongoose = require("mongoose");
const db = require("../../models");
const { logOrderLifecycleEvent } = require("../../service/orderLifecycleLogger");
const controller = require("../etsyOrder.controller");

function chainResolve(value, methods = ["select", "sort", "populate", "lean"]) {
  const chain = {};
  methods.forEach((method) => {
    chain[method] = jest.fn().mockReturnValue(chain);
  });
  chain.lean = jest.fn().mockResolvedValue(value);
  return chain;
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

describe("createOrder auto base cost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("computes base cost immediately after extension imports a new Etsy order", async () => {
    const shopId = new mongoose.Types.ObjectId();
    const orderDocId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    const vendorProductId = new mongoose.Types.ObjectId();

    const importedItem = {
      _id: new mongoose.Types.ObjectId(),
      transactionId: "5126472805",
      sku: "J2522-NK-1106-5",
      quantity: 1,
      variations: {
        "Product Type": "Napkins",
        Size: "4.8x4.8 INCHES",
        Quantity: "Pack 15pcs",
      },
    };
    const createdOrder = {
      _id: orderDocId,
      orderId: "4099502738",
      shopId,
      items: [importedItem],
      seller: { sellerCode: "J2522" },
    };

    db.EtsyOrder.findOne.mockResolvedValue(null);
    db.EtsyOrder.create.mockResolvedValue(createdOrder);
    db.EtsyOrder.bulkWrite.mockResolvedValue({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
    db.EtsyOrder.updateOne.mockResolvedValue({ modifiedCount: 1 });
    db.user.findOne.mockReturnValue(chainResolve(null, ["select", "lean"]));
    db.configCostCenter.find.mockReturnValue(chainResolve([{
      config_code: "NK",
      customize_product_type_key: ["Product Type"],
      customize_size_key: ["Size"],
      customize_color_key: ["Quantity"],
      product_for_seller: {
        name: "Napkins",
        items: [{
          vendor_product: vendorProductId,
          vendor_id: vendorId,
          status: "Active",
          order: 1,
          display_name: "LNG Group - Napkins",
        }],
      },
    }], ["populate", "lean"]));
    db.configOptionMapping.find.mockReturnValue(chainResolve([], ["sort", "lean"]));
    db.vendorCostCenter.find.mockReturnValue(chainResolve([{
      vendor_product: vendorProductId,
      vendor_size: "4.8x4.8 INCHES",
      vendor_color: "Pack 15pcs",
      base_cost: 1,
      sku: "VCC-NK-001",
      international: { economy: 0, additional: 0 },
      additional_costs: {},
    }], ["select", "lean"]));
    db.vendorProduct.findById.mockReturnValue(chainResolve({ vendor_id: vendorId }, ["select", "lean"]));

    const req = {
      body: {
        orderId: "4099502738",
        shopId: String(shopId),
        items: [importedItem],
      },
    };
    const res = makeRes();

    await controller.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(db.EtsyOrder.bulkWrite).toHaveBeenCalledTimes(1);
    expect(db.EtsyOrder.updateOne).toHaveBeenCalledWith(
      { _id: orderDocId },
      expect.objectContaining({
        $set: expect.objectContaining({ base_cost: 2 }),
      })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      created: true,
      autoBaseCost: expect.objectContaining({
        ok: true,
        base_cost: 2,
        preferred_vendor_id: null,
      }),
    }));
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      orderId: "4099502738",
      stage: "IMPORT",
      eventType: "ORDER_IMPORTED",
      status: "success",
    }));
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      orderId: "4099502738",
      stage: "AUTO_COST",
      eventType: "AUTO_COST_SUCCESS",
      status: "success",
      metadata: expect.objectContaining({ base_cost: 2 }),
    }));
  });

  test("logs auto cost failure without failing the order import", async () => {
    const shopId = new mongoose.Types.ObjectId();
    const orderDocId = new mongoose.Types.ObjectId();
    const importedItem = {
      _id: new mongoose.Types.ObjectId(),
      transactionId: "5126472805",
      sku: "J2522-NK-1106-5",
      quantity: 1,
      variations: { "Product Type": "Napkins" },
    };
    const createdOrder = {
      _id: orderDocId,
      orderId: "4099502739",
      shopId,
      items: [importedItem],
      seller: { sellerCode: "J2522" },
    };

    db.EtsyOrder.findOne.mockResolvedValue(null);
    db.EtsyOrder.create.mockResolvedValue(createdOrder);
    db.EtsyOrder.updateOne.mockResolvedValue({ modifiedCount: 1 });
    db.user.findOne.mockReturnValue(chainResolve(null, ["select", "lean"]));
    db.configCostCenter.find.mockImplementation(() => {
      throw new Error("config query failed");
    });

    const req = {
      body: {
        orderId: "4099502739",
        shopId: String(shopId),
        items: [importedItem],
      },
    };
    const res = makeRes();

    await controller.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      created: true,
      autoBaseCost: { ok: false, error: "config query failed" },
    }));
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      orderId: "4099502739",
      stage: "AUTO_COST",
      eventType: "AUTO_COST_FAILED",
      status: "failed",
      reason: "config query failed",
    }));
  });

  test("skips old existing Etsy order unless forceBackfill is set", async () => {
    const shopId = new mongoose.Types.ObjectId();
    const existing = {
      _id: new mongoose.Types.ObjectId(),
      orderId: "4095756706",
      shopId,
      createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      items: [],
    };
    db.EtsyOrder.findOne.mockResolvedValue(existing);

    const req = {
      body: {
        orderId: "4095756706",
        shopId: String(shopId),
        items: [{ transactionId: "tx-1", sku: "SKU-1", quantity: 1 }],
      },
    };
    const res = makeRes();

    await controller.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      duplicated: true,
      skipped: true,
      reason: "existing_order_outside_backfill_window",
      backfilled: false,
      autoBaseCost: null,
    }));
    expect(logOrderLifecycleEvent).not.toHaveBeenCalled();
    expect(db.EtsyOrder.updateOne).not.toHaveBeenCalled();
  });

  test("skips lifecycle and auto cost when existing Etsy order has no backfill changes", async () => {
    const shopId = new mongoose.Types.ObjectId();
    const existingItem = {
      transactionId: "tx-1",
      listingId: "listing-1",
      sku: "SKU-1",
      itemName: "Item",
      quantity: 1,
      variations: { Size: "S" },
      customizations: { textFields: [] },
      customFiles: [],
    };
    const existing = {
      _id: new mongoose.Types.ObjectId(),
      orderId: "4095756707",
      shopId,
      createdAt: new Date(),
      items: [existingItem],
      shipping: {},
      seller: { sellerCode: "SKU" },
      save: jest.fn(),
      markModified: jest.fn(),
    };
    db.EtsyOrder.findOne.mockResolvedValue(existing);

    const req = {
      body: {
        orderId: "4095756707",
        shopId: String(shopId),
        seller: { sellerCode: "SKU" },
        items: [existingItem],
      },
    };
    const res = makeRes();

    await controller.createOrder(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      duplicated: true,
      skipped: true,
      reason: "existing_order_no_backfill_changes",
      backfilled: false,
      autoBaseCost: null,
    }));
    expect(existing.save).not.toHaveBeenCalled();
    expect(logOrderLifecycleEvent).not.toHaveBeenCalled();
    expect(db.EtsyOrder.bulkWrite).not.toHaveBeenCalled();
  });
});
