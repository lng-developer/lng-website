const { shopifyGraphQL } = require("./shopifyClient.service");

async function createShopifyFulfillment({
  fulfillmentOrderId,
  trackingNumber,
  trackingCompany,
  trackingUrl,
}) {
  const data = await shopifyGraphQL(
    `
      mutation FulfillmentCreate($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment {
            id
            status
            trackingInfo {
              number
              company
              url
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId,
          },
        ],
        notifyCustomer: true,
        trackingInfo: {
          number: trackingNumber,
          company: trackingCompany,
          url: trackingUrl,
        },
      },
    }
  );

  const result = data?.fulfillmentCreateV2 || {};
  const userErrors = Array.isArray(result.userErrors) ? result.userErrors : [];
  if (userErrors.length) {
    const err = new Error(userErrors.map((item) => item.message).filter(Boolean).join("; "));
    err.code = "SHOPIFY_FULFILLMENT_USER_ERRORS";
    err.userErrors = userErrors;
    throw err;
  }

  return result.fulfillment || null;
}

module.exports = {
  createShopifyFulfillment,
};
