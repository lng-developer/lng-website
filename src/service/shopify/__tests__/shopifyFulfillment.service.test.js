const mockShopifyGraphQL = jest.fn();

jest.mock("../shopifyClient.service", () => ({
  shopifyGraphQL: mockShopifyGraphQL,
}));

describe("createShopifyFulfillment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("calls Shopify fulfillmentCreateV2 with tracking info and notifyCustomer", async () => {
    mockShopifyGraphQL.mockResolvedValue({
      fulfillmentCreateV2: {
        fulfillment: {
          id: "gid://shopify/Fulfillment/123",
          status: "SUCCESS",
          trackingInfo: [
            {
              number: "940011189922385",
              company: "USPS",
              url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=940011189922385",
            },
          ],
        },
        userErrors: [],
      },
    });

    const { createShopifyFulfillment } = require("../shopifyFulfillment.service");

    const result = await createShopifyFulfillment({
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987",
      trackingNumber: "940011189922385",
      trackingCompany: "USPS",
      trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=940011189922385",
    });

    expect(mockShopifyGraphQL).toHaveBeenCalledWith(
      expect.stringContaining("mutation FulfillmentCreate"),
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: [
            {
              fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987",
            },
          ],
          notifyCustomer: true,
          trackingInfo: {
            number: "940011189922385",
            company: "USPS",
            url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=940011189922385",
          },
        },
      }
    );
    expect(result).toEqual({
      id: "gid://shopify/Fulfillment/123",
      status: "SUCCESS",
      trackingInfo: [
        {
          number: "940011189922385",
          company: "USPS",
          url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=940011189922385",
        },
      ],
    });
  });

  test("throws Shopify user error messages", async () => {
    mockShopifyGraphQL.mockResolvedValue({
      fulfillmentCreateV2: {
        fulfillment: null,
        userErrors: [
          { field: ["fulfillment"], message: "Fulfillment order is closed" },
          { field: ["trackingInfo"], message: "Tracking number is invalid" },
        ],
      },
    });

    const { createShopifyFulfillment } = require("../shopifyFulfillment.service");

    await expect(createShopifyFulfillment({
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987",
      trackingNumber: "bad",
      trackingCompany: "USPS",
      trackingUrl: "https://tools.usps.com",
    })).rejects.toThrow("Fulfillment order is closed; Tracking number is invalid");
  });
});
