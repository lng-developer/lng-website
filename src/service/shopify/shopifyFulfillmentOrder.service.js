const { shopifyGraphQL } = require("./shopifyClient.service");

async function getShopifyFulfillmentOrder(orderGid) {
  if (!orderGid) return null;

  try {

    const data = await shopifyGraphQL(
      `
      query ShopifyOrderFulfillmentOrders($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first:1) {
            edges {
              node {
                id
                status
              }
            }
          }
        }
      }
      `,
      { id: orderGid }
    );

    const edges = data?.order?.fulfillmentOrders?.edges;

    return Array.isArray(edges)
      ? edges[0]?.node || null
      : null;

  } catch(err) {

    console.error(
      "[SHOPIFY][FULFILLMENT_ORDER][ERROR]",
      {
        orderGid,
        message: err.message
      }
    );

    return null;
  }
}

module.exports = {
  getShopifyFulfillmentOrder,
};
