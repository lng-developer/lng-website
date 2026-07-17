const mockShopifyGraphQL = jest.fn();

jest.mock("../shopifyClient.service", () => ({
  shopifyGraphQL: mockShopifyGraphQL,
}));

describe("getShopifyFulfillmentOrder", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  test("returns the first fulfillment order for a Shopify order gid", async () => {
    mockShopifyGraphQL.mockResolvedValue({
      order: {
        fulfillmentOrders: {
          edges: [
            {
              node: {
                id: "gid://shopify/FulfillmentOrder/987654321",
                status: "OPEN",
              },
            },
          ],
        },
      },
    });

    const { getShopifyFulfillmentOrder } = require("../shopifyFulfillmentOrder.service");

    const result = await getShopifyFulfillmentOrder("gid://shopify/Order/7677972775049");

    expect(mockShopifyGraphQL).toHaveBeenCalledWith(
      expect.stringContaining("query ShopifyOrderFulfillmentOrders($id: ID!)"),
      { id: "gid://shopify/Order/7677972775049" }
    );
    expect(result).toEqual({
      id: "gid://shopify/FulfillmentOrder/987654321",
      status: "OPEN",
    });
  });

  test("returns null when Shopify has no fulfillment order", async () => {
    mockShopifyGraphQL.mockResolvedValue({
      order: {
        fulfillmentOrders: {
          edges: [],
        },
      },
    });

    const { getShopifyFulfillmentOrder } = require("../shopifyFulfillmentOrder.service");

    await expect(getShopifyFulfillmentOrder("gid://shopify/Order/7677972775049")).resolves.toBeNull();
  });

  test("logs and returns null when Shopify GraphQL fails", async () => {
    mockShopifyGraphQL.mockRejectedValue(new Error("GraphQL failed"));

    const { getShopifyFulfillmentOrder } = require("../shopifyFulfillmentOrder.service");

    await expect(getShopifyFulfillmentOrder("gid://shopify/Order/7677972775049")).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "[SHOPIFY][FULFILLMENT_ORDER][ERROR]",
      {
        orderGid: "gid://shopify/Order/7677972775049",
        message: "GraphQL failed",
      }
    );
  });
});
