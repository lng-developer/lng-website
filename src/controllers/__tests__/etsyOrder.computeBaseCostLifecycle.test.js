jest.mock("../../models", () => ({
  EtsyOrder: {
    findOne: jest.fn(),
    bulkWrite: jest.fn(),
    updateOne: jest.fn(),
  },
  vendorProduct: { findById: jest.fn() },
  vendorCostCenter: { find: jest.fn(), findById: jest.fn() },
  configCostCenter: { find: jest.fn() },
  configOptionMapping: { find: jest.fn() },
  user: { findOne: jest.fn() },
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

function makeOrder() {
  return {
    _id: new mongoose.Types.ObjectId(),
    orderId: "4099502738",
    shopId: new mongoose.Types.ObjectId(),
    shipping_type: "Standard",
    base_cost: 0,
    items: [{
      transactionId: "5126472805",
      sku: "J2522-NK-1106-5",
      quantity: 1,
      variations: {
        "Product Type": "Napkins",
        Size: "4.8x4.8 INCHES",
        Quantity: "Pack 15pcs",
      },
    }],
  };
}

describe("computeBaseCostForEtsyOrder lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.EtsyOrder.bulkWrite.mockResolvedValue({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
    db.EtsyOrder.updateOne.mockResolvedValue({ modifiedCount: 1 });
    db.configOptionMapping.find.mockReturnValue(chainResolve([], ["sort", "lean"]));
  });

  test("logs AUTO_COST_RETEST_SUCCESS when Etsy retest matches cost", async () => {
    const vendorId = new mongoose.Types.ObjectId();
    const vendorProductId = new mongoose.Types.ObjectId();
    const order = makeOrder();

    db.EtsyOrder.findOne.mockResolvedValue(order);
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
    db.vendorCostCenter.find.mockReturnValue(chainResolve([{
      vendor_size: "4.8x4.8 INCHES",
      vendor_color: "Pack 15pcs",
      base_cost: 10,
      international: { economy: 1, additional: 0 },
    }], ["select", "lean"]));
    db.vendorProduct.findById.mockReturnValue(chainResolve({ vendor_id: vendorId }, ["select", "lean"]));

    await controller.computeBaseCostForEtsyOrder({
      body: { orderId: order.orderId },
      user: { _id: "user-1", email: "cs@example.com" },
    }, makeRes());

    expect(order.base_cost).toBe(12);
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      orderId: order.orderId,
      stage: "AUTO_COST",
      eventType: "AUTO_COST_RETEST_SUCCESS",
      status: "success",
      metadata: expect.objectContaining({
        newBaseCost: 12,
        itemCount: 1,
        failedItemCount: 0,
      }),
    }));
  });

  test("logs AUTO_COST_RETEST_FAILED when Etsy retest cannot match config", async () => {
    const order = makeOrder();
    db.EtsyOrder.findOne.mockResolvedValue(order);
    db.configCostCenter.find.mockReturnValue(chainResolve([], ["populate", "lean"]));

    await controller.computeBaseCostForEtsyOrder({
      body: { orderId: order.orderId },
      user: { _id: "user-1", email: "cs@example.com" },
    }, makeRes());

    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      orderId: order.orderId,
      stage: "AUTO_COST",
      eventType: "AUTO_COST_RETEST_FAILED",
      status: "failed",
      reason: "No config cost center found by config_code",
      metadata: expect.objectContaining({
        newBaseCost: 0,
        failedItemCount: 1,
        failedItems: [expect.objectContaining({
          transactionId: "5126472805",
          configCode: "NK",
          reason: "No config cost center found by config_code",
        })],
      }),
    }));
  });
});
