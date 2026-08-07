jest.mock("../../models", () => ({
  EtsyOrder: {
    bulkWrite: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
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
  user: {},
  role: {},
  shop: {},
}));

jest.mock("../../models/etsyListing.model", () => ({ find: jest.fn() }));
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
jest.mock("axios", () => ({}));

const fs = require("fs");
const os = require("os");
const path = require("path");
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

describe("importOrders auto base cost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("recomputes base cost when an order CSV updates an order that already has items", async () => {
    const shopId = new mongoose.Types.ObjectId();
    const orderDocId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    const vendorProductId = new mongoose.Types.ObjectId();
    const tmpFile = path.join(os.tmpdir(), `etsy-orders-${Date.now()}.csv`);
    fs.writeFileSync(tmpFile, [
      "Order ID,Buyer User ID,Sale Date,Date Shipped,Currency,Payment Method,Full Name,Street 1,Street 2,Ship City,Ship State,Ship Zipcode,Ship Country,Order Value,Shipping,Order Total,Discount Amount,Card Processing Fees,Order Net,Sales Tax",
      "4099502738,buyer1,Jun 26 2026,,USD,cc,Kristen Miller,1 Main,,Toronto,ON,M5V,CA,10,0,10,0,0,10,0",
    ].join("\n"));

    const existingOrder = {
      _id: orderDocId,
      orderId: "4099502738",
      shopId,
      shipping: { country: "CA" },
      items: [{
        _id: new mongoose.Types.ObjectId(),
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

    db.EtsyOrder.find
      .mockReturnValueOnce(chainResolve([existingOrder], ["select", "lean"]))
      .mockReturnValueOnce({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });
    db.EtsyOrder.bulkWrite.mockResolvedValue({ modifiedCount: 1 });
    db.EtsyOrder.findOne.mockResolvedValue(existingOrder);
    db.EtsyOrder.updateOne.mockResolvedValue({ modifiedCount: 1 });
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
      body: { shopId: String(shopId) },
      files: [{ path: tmpFile }],
    };
    const res = makeRes();

    await controller.importOrders(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(db.EtsyOrder.bulkWrite).toHaveBeenCalledTimes(2);
    expect(
      db.EtsyOrder.bulkWrite.mock.calls[0][0][0].updateOne.update.$set["totals.fee"]
    ).toBe(1.67);
    expect(db.EtsyOrder.updateOne).toHaveBeenCalledWith(
      { _id: orderDocId },
      expect.objectContaining({
        $set: expect.objectContaining({ base_cost: 2 }),
      })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      stats: expect.objectContaining({ ordersCostComputed: 1 }),
    }));
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      orderId: "4099502738",
      stage: "IMPORT",
      eventType: "ORDER_FILE_IMPORTED",
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
});
