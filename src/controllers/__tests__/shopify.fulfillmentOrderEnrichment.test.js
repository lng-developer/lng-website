const mockFindOne = jest.fn();
const mockCreate = jest.fn();
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

jest.mock("../../models", () => ({
  orderProductShopify: {
    findOne: mockFindOne,
    create: mockCreate,
  },
}));

function createWebhookPayload() {
  return {
    id: 7677972775049,
    name: "#1009",
    created_at: "2026-07-17T10:00:00-04:00",
    updated_at: "2026-07-17T10:05:00-04:00",
    financial_status: "paid",
    fulfillment_status: "unfulfilled",
    total_price: "25.99",
    currency: "USD",
    line_items: [],
  };
}

describe("Shopify fulfillment order enrichment", () => {
  let consoleLogSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  test("orders/create resolves fulfillmentOrderId before saving a new order", async () => {
    const { handleOrderCreatedWebhook } = require("../shopify.controller");
    mockFindOne.mockResolvedValue(null);
    mockGetShopifyFulfillmentOrder.mockResolvedValue({
      id: "gid://shopify/FulfillmentOrder/987654321",
      status: "OPEN",
    });
    const req = {
      body: createWebhookPayload(),
      headers: {
        "x-shopify-topic": "orders/create",
        "x-shopify-shop-domain": "d1xx0b-aq.myshopify.com",
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handleOrderCreatedWebhook(req, res);

    expect(mockGetShopifyFulfillmentOrder).toHaveBeenCalledWith(
      "gid://shopify/Order/7677972775049"
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        shopifyOrderName: "#1009",
        fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987654321",
      })
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[SHOPIFY][FULFILLMENT_ORDER][RESOLVED]",
      {
        shopifyOrderId: "7677972775049",
        shopifyOrderName: "#1009",
        fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987654321",
      }
    );
  });

  test("orders/updated resolves fulfillmentOrderId only when it is missing", async () => {
    const { handleOrderUpdatedWebhook } = require("../shopify.controller");
    const existingOrder = {
      shopifyOrderId: "7677972775049",
      shopifyOrderGid: "gid://shopify/Order/7677972775049",
      fulfillmentOrderId: "",
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockFindOne.mockResolvedValue(existingOrder);
    mockGetShopifyFulfillmentOrder.mockResolvedValue({
      id: "gid://shopify/FulfillmentOrder/987654321",
      status: "OPEN",
    });
    const req = { body: createWebhookPayload(), headers: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handleOrderUpdatedWebhook(req, res);

    expect(mockGetShopifyFulfillmentOrder).toHaveBeenCalledWith(
      "gid://shopify/Order/7677972775049"
    );
    expect(existingOrder.fulfillmentOrderId).toBe("gid://shopify/FulfillmentOrder/987654321");
    expect(existingOrder.save).toHaveBeenCalledTimes(1);
  });
});
