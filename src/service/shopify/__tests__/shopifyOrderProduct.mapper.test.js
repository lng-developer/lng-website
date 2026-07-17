const {
  mapShopifyOrderToOrderProductShopify,
} = require("../shopifyOrderProduct.mapper");

describe("mapShopifyOrderToOrderProductShopify", () => {
  test("maps the first Shopify fulfillment order id for future fulfillment sync", () => {
    const mapped = mapShopifyOrderToOrderProductShopify(
      {
        id: "gid://shopify/Order/123456789",
        name: "#1001",
        displayFinancialStatus: "paid",
        displayFulfillmentStatus: "unfulfilled",
        fulfillmentOrders: [
          { id: "gid://shopify/FulfillmentOrder/987654321" },
          { id: "gid://shopify/FulfillmentOrder/222222222" },
        ],
        lineItems: [],
      },
      { shopDomain: "d1xx0b-aq.myshopify.com" }
    );

    expect(mapped.fulfillmentOrderId).toBe("gid://shopify/FulfillmentOrder/987654321");
  });
});
