const mockFindOne = jest.fn();
const mockCreateShopifyFulfillment = jest.fn();
const mockGetShopifyFulfillmentOrder = jest.fn();

jest.mock("../../service/shopify/shopifyClient.service", () => ({
  shopifyGraphQL: jest.fn(),
}));

jest.mock("../../service/shopify/shopifyWebhook.service", () => ({
  createOrdersCreateWebhook: jest.fn(),
  createOrdersUpdatedWebhook: jest.fn(),
  createOrdersCancelledWebhook: jest.fn(),
}));

jest.mock("../../service/shopify/shopifyFulfillmentOrder.service", () => ({
  getShopifyFulfillmentOrder: mockGetShopifyFulfillmentOrder,
}));

jest.mock("../../service/shopify/shopifyFulfillment.service", () => ({
  createShopifyFulfillment: mockCreateShopifyFulfillment,
}));

jest.mock("../../models", () => ({
  orderProductShopify: {
    findOne: mockFindOne,
  },
}));

describe("handleCreateFulfillment", () => {
  let consoleLogSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  test("creates Shopify fulfillment and updates tracking info", async () => {
    const { handleCreateFulfillment } = require("../shopify.controller");
    const order = {
      shopifyOrderId: "1009",
      shopifyOrderGid: "gid://shopify/Order/1009",
      shopifyOrderName: "#1009",
      fulfillmentOrderId: "stale-fulfillment-order-id",
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockFindOne.mockResolvedValue(order);
    mockGetShopifyFulfillmentOrder.mockResolvedValue({
      id: "gid://shopify/FulfillmentOrder/987",
      status: "OPEN",
    });
    mockCreateShopifyFulfillment.mockResolvedValue({
      id: "gid://shopify/Fulfillment/123",
      status: "SUCCESS",
    });
    const req = {
      params: { orderId: "1009" },
      body: {
        trackingNumber: "940011189922385",
        trackingCompany: "USPS",
        trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=940011189922385",
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handleCreateFulfillment(req, res);

    expect(mockFindOne).toHaveBeenCalledWith({ shopifyOrderId: "1009" });
    expect(mockGetShopifyFulfillmentOrder).toHaveBeenCalledWith("gid://shopify/Order/1009");
    expect(mockCreateShopifyFulfillment).toHaveBeenCalledWith({
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987",
      trackingNumber: "940011189922385",
      trackingCompany: "USPS",
      trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=940011189922385",
    });
    expect(order.fulfillmentOrderId).toBe("gid://shopify/FulfillmentOrder/987");
    expect(order.lastShopifySyncAt).toBeInstanceOf(Date);
    expect(order.fulfillmentStatus).toBe("fulfilled");
    expect(order.trackingInfo).toEqual({
      fulfillmentId: "gid://shopify/Fulfillment/123",
      status: "SUCCESS",
      trackingNumber: "940011189922385",
      trackingCompany: "USPS",
      trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=940011189922385",
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(order.save).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      fulfilled: true,
      shopifyOrderId: "1009",
      fulfillmentId: "gid://shopify/Fulfillment/123",
      status: "SUCCESS",
    });
  });

  test("requires trackingNumber before creating Shopify fulfillment", async () => {
    const { handleCreateFulfillment } = require("../shopify.controller");
    mockFindOne.mockResolvedValue({
      shopifyOrderId: "1009",
      shopifyOrderGid: "gid://shopify/Order/1009",
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987",
    });
    const req = {
      params: { orderId: "1009" },
      body: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handleCreateFulfillment(req, res);

    expect(mockGetShopifyFulfillmentOrder).not.toHaveBeenCalled();
    expect(mockCreateShopifyFulfillment).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      message: "Missing trackingNumber",
    });
  });

  test("returns 400 when fulfillment order cannot be resolved", async () => {
    const { handleCreateFulfillment } = require("../shopify.controller");
    mockFindOne.mockResolvedValue({
      shopifyOrderId: "1009",
      shopifyOrderGid: "gid://shopify/Order/1009",
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987",
    });
    mockGetShopifyFulfillmentOrder.mockResolvedValue(null);
    const req = {
      params: { orderId: "1009" },
      body: { trackingNumber: "940011189922385" },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handleCreateFulfillment(req, res);

    expect(mockCreateShopifyFulfillment).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      message: "Fulfillment order not found",
    });
  });

  test("returns 400 when fulfillment order is not OPEN", async () => {
    const { handleCreateFulfillment } = require("../shopify.controller");
    mockFindOne.mockResolvedValue({
      shopifyOrderId: "1009",
      shopifyOrderGid: "gid://shopify/Order/1009",
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987",
    });
    mockGetShopifyFulfillmentOrder.mockResolvedValue({
      id: "gid://shopify/FulfillmentOrder/987",
      status: "CLOSED",
    });
    const req = {
      params: { orderId: "1009" },
      body: { trackingNumber: "940011189922385" },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handleCreateFulfillment(req, res);

    expect(mockCreateShopifyFulfillment).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      message: "Fulfillment order is not available",
      status: "CLOSED",
    });
  });
});
