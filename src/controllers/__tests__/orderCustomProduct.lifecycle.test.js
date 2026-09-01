jest.mock("../../models", () => ({
  orderCustomProduct: { findOne: jest.fn() },
  EtsyOrder: {},
  shop: {},
  configCostCenter: { find: jest.fn() },
  vendorCostCenter: { find: jest.fn(), findById: jest.fn() },
  vendorProduct: { findById: jest.fn() },
  configOptionMapping: { find: jest.fn() },
  user: {},
  SkuMappingConfig: {},
  SkuMappingEntry: {},
  listing: {},
  PsdTask: {},
  OrderHistory: {},
}));

jest.mock("../../service/orderHistoryLogger", () => ({
  logOrderHistory: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../service/orderLifecycleLogger", () => ({
  logOrderLifecycleEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../utils/skuMigrate", () => ({
  applyRulesToSku: jest.fn(),
  buildRulesFromConfig: jest.fn(),
}));

jest.mock("../../helper/orderHelper", () => ({
  validateIds: jest.fn(),
  buildInitialMatch: jest.fn(),
  buildFilters: jest.fn(),
  buildVendorFilter: jest.fn(),
  buildSelectedVendorsFilter: jest.fn(),
  buildPipeline: jest.fn(),
  executePipeline: jest.fn(),
  enrichOrdersData: jest.fn(),
  getVendorProductIdsByVendorName: jest.fn(),
  getListingIdsNoPsd: jest.fn(),
  normalizeBool: jest.fn(),
}));

const db = require("../../models");
const { logOrderHistory } = require("../../service/orderHistoryLogger");
const { logOrderLifecycleEvent } = require("../../service/orderLifecycleLogger");
const controller = require("../orderCustomProduct.controller");

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeQuery(result, methods = ["lean"]) {
  const chain = {};
  for (const method of methods) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.lean = jest.fn().mockResolvedValue(result);
  return chain;
}

describe("order custom product lifecycle hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("updateOrderStatus logs ORDER_STATUS_CHANGED when status changes", async () => {
    const order = {
      _id: "order-object-id",
      orderId: "111-2222222-3333333",
      platform: "Amazon",
      shopId: "shop-1",
      status: "New",
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.orderCustomProduct.findOne.mockResolvedValue(order);

    const req = {
      body: { orderId: order.orderId, status: "Fulfilled" },
      user: { _id: "user-1", email: "cs@example.com" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.updateOrderStatus(req, res);

    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "amazon",
      orderId: order.orderId,
      stage: "ORDER_STATUS",
      eventType: "ORDER_STATUS_CHANGED",
      status: "success",
      actorType: "user",
      actorName: "cs@example.com",
      metadata: { fromStatus: "New", toStatus: "Fulfilled" },
    }));
  });

  test("updateBaseCost logs user actor and old/new cost", async () => {
    const order = {
      _id: "order-object-id",
      orderId: "111-2222222-3333333",
      platform: "Amazon",
      shopId: "shop-1",
      base_cost: 10,
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.orderCustomProduct.findOne.mockResolvedValue(order);

    const req = {
      body: { orderId: order.orderId, base_cost: 12.5 },
      user: { _id: "user-1", email: "cs@example.com" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.updateBaseCost(req, res);

    expect(order.base_cost).toBe(12.5);
    expect(logOrderHistory).toHaveBeenCalledWith(expect.objectContaining({
      action: "UPDATE_BASE_COST",
      description: "Order base cost manually updated",
      user: req.user,
      changes: [
        {
          field: "base_cost",
          from: 10,
          to: 12.5,
        },
      ],
    }));
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "amazon",
      orderId: order.orderId,
      stage: "BASE_COST",
      eventType: "ORDER_BASE_COST_UPDATED",
      status: "success",
      actorType: "user",
      actorId: "user-1",
      actorName: "cs@example.com",
      metadata: { oldBaseCost: 10, newBaseCost: 12.5 },
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("updateOrderStatus does not log lifecycle event on no-op status", async () => {
    db.orderCustomProduct.findOne.mockResolvedValue({
      orderId: "111-2222222-3333333",
      status: "New",
    });

    const res = makeRes();
    await controller.updateOrderStatus({ body: { orderId: "111-2222222-3333333", status: "New" } }, res);

    expect(logOrderLifecycleEvent).not.toHaveBeenCalled();
  });

  test("computeBaseCostForOrder logs AUTO_COST_RETEST_SUCCESS when retest matches cost", async () => {
    const order = {
      _id: "order-object-id",
      orderId: "113-1524195-6858656",
      platform: "Amazon",
      shopId: "shop-1",
      shipping_type: "Standard",
      base_cost: 0,
      base_cost_shipping_groups: [],
      items: [{
        orderItemId: "item-1",
        sku: "J2614-NK-180626-06",
        quantity: 1,
        customizationData: {
          children: [{
            children: [{
              children: [
                { label: "Size", optionSelection: { label: "4.8x4.8 INCHES" } },
                { label: "Color", optionSelection: { label: "15 pcs" } },
              ],
            }],
          }],
        },
      }],
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.orderCustomProduct.findOne.mockReturnValue(makeQuery(order));
    db.configCostCenter.find.mockReturnValue(makeQuery([{
      config_code: "NK",
      customize_size_key: ["Size"],
      customize_color_key: ["Color"],
      product_for_seller: {
        items: [{
          vendor_product: "vendor-product-1",
          vendor_id: "vendor-1",
          status: "Active",
          order: 1,
          display_name: "Napkins",
        }],
      },
    }], ["populate", "lean"]));
    db.configOptionMapping.find.mockReturnValue(makeQuery([], ["sort", "lean"]));
    db.vendorCostCenter.find.mockReturnValue(makeQuery([{
      vendor_size: "4.8x4.8 INCHES",
      vendor_color: "15 pcs",
      base_cost: 10,
    }], ["select", "lean"]));
    db.vendorProduct.findById.mockReturnValue(makeQuery({ vendor_id: "vendor-1" }, ["select", "lean"]));

    const req = {
      body: { orderId: order.orderId },
      user: { _id: "user-1", email: "cs@example.com" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.computeBaseCostForOrder(req, res);

    expect(order.base_cost).toBe(11);
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "amazon",
      orderId: order.orderId,
      stage: "AUTO_COST",
      eventType: "AUTO_COST_RETEST_SUCCESS",
      status: "success",
      actorType: "user",
      metadata: expect.objectContaining({
        oldBaseCost: 0,
        newBaseCost: 11,
        itemCount: 1,
        failedItemCount: 0,
      }),
    }));
  });

  test("autoMatchBaseCostForOrder previews auto mapping without overwriting manual mapping", async () => {
    const order = {
      _id: "order-object-id",
      orderId: "113-9515230-9546657",
      platform: "Amazon",
      shopId: "shop-1",
      shipping_type: "Standard",
      forced_vendor_id: "manual-vendor",
      base_cost: 13.89,
      base_cost_shipping_groups: [],
      items: [{
        orderItemId: "item-1",
        sku: "J2512-TS2S-201025-9014",
        manual_vendor_cost_center_id: "manual-cost-center",
        quantity: 1,
        customizationData: {
          children: [{
            children: [{
              children: [
                { label: "Size", optionSelection: { label: "M" } },
                { label: "Color", optionSelection: { label: "Maroon" } },
                { label: "Product Type", optionSelection: { label: "Premium Sweatshirt" } },
              ],
            }],
          }],
        },
        cost_breakdown: {
          selectedConfigBy: "manual",
          itemDisplayName: "Manual Selection",
          vendorProductId: "manual-shirt-product",
          matchedSku: "11975",
        },
      }],
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.orderCustomProduct.findOne.mockReturnValue(makeQuery(order));
    db.configCostCenter.find.mockReturnValue(makeQuery([{
      config_code: "TS2S",
      product_type: "Premium Sweatshirt",
      customize_size_key: ["Size"],
      customize_color_key: ["Color"],
      product_for_seller: {
        items: [{
          vendor_product: "sweatshirt-product",
          vendor_id: "sweatshirt-vendor",
          status: "Active",
          order: 2,
          display_name: "Unisex Crewneck Sweatshirt",
        }],
      },
    }], ["populate", "lean"]));
    db.configOptionMapping.find.mockReturnValue(makeQuery([], ["sort", "lean"]));
    db.vendorCostCenter.find.mockReturnValue(makeQuery([{
      sku: "SW-18000-MAN-M",
      vendor_size: "M",
      vendor_color: "Maroon",
      base_cost: 11.09,
    }], ["select", "lean"]));
    db.vendorProduct.findById.mockReturnValue(makeQuery({ vendor_id: "sweatshirt-vendor" }, ["select", "lean"]));

    const res = makeRes();
    await controller.autoMatchBaseCostForOrder({
      body: { orderId: order.orderId },
      user: { _id: "user-1", email: "cs@example.com" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    }, res);

    expect(db.vendorCostCenter.findById).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
    expect(logOrderHistory).not.toHaveBeenCalled();
    expect(logOrderLifecycleEvent).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true,
      ignore_manual_mapping: true,
      base_cost: 11.09,
      preferred_vendor_id: null,
      detail: [expect.objectContaining({
        selectedConfigBy: "product_type_exact",
        itemDisplayName: "Unisex Crewneck Sweatshirt",
        vendorProductId: "sweatshirt-product",
        matchedSku: "SW-18000-MAN-M",
      })],
    }));
  });

  test("computeBaseCostForOrder logs AUTO_COST_RETEST_FAILED when retest cannot match cost", async () => {
    const order = {
      _id: "order-object-id",
      orderId: "113-1524195-6858656",
      platform: "Amazon",
      shopId: "shop-1",
      shipping_type: "Standard",
      base_cost: 0,
      base_cost_shipping_groups: [],
      items: [{
        orderItemId: "item-1",
        sku: "J2614-NK-180626-06",
        quantity: 1,
      }],
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.orderCustomProduct.findOne.mockReturnValue(makeQuery(order));
    db.configCostCenter.find.mockReturnValue(makeQuery([], ["populate", "lean"]));

    const res = makeRes();
    await controller.computeBaseCostForOrder({
      body: { orderId: order.orderId },
      user: { _id: "user-1", email: "cs@example.com" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    }, res);

    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "amazon",
      orderId: order.orderId,
      stage: "AUTO_COST",
      eventType: "AUTO_COST_RETEST_FAILED",
      status: "failed",
      reason: "No config cost center found by config_code",
      metadata: expect.objectContaining({
        oldBaseCost: 0,
        newBaseCost: 0,
        failedItemCount: 1,
        failedItems: [expect.objectContaining({
          orderItemId: "item-1",
          configCode: "NK",
          reason: "No config cost center found by config_code",
        })],
      }),
    }));
  });
});
