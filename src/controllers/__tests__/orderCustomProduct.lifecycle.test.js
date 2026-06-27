jest.mock("../../models", () => ({
  orderCustomProduct: { findOne: jest.fn() },
  EtsyOrder: {},
  shop: {},
  configCostCenter: {},
  vendorCostCenter: {},
  vendorProduct: {},
  configOptionMapping: {},
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
const { logOrderLifecycleEvent } = require("../../service/orderLifecycleLogger");
const controller = require("../orderCustomProduct.controller");

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
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

  test("updateOrderStatus does not log lifecycle event on no-op status", async () => {
    db.orderCustomProduct.findOne.mockResolvedValue({
      orderId: "111-2222222-3333333",
      status: "New",
    });

    const res = makeRes();
    await controller.updateOrderStatus({ body: { orderId: "111-2222222-3333333", status: "New" } }, res);

    expect(logOrderLifecycleEvent).not.toHaveBeenCalled();
  });
});
