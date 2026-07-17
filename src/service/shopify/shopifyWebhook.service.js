const { shopifyGraphQL } = require("./shopifyClient.service");


async function createOrdersCreateWebhook() {

    const mutation = `
    mutation CreateOrdersCreateWebhook {
        webhookSubscriptionCreate(
            topic: ORDERS_CREATE,
            webhookSubscription: {
                callbackUrl: "https://api.lngmerch.co/api/shopify/webhooks/orders-create",
                format: JSON
            }
        ) {
            webhookSubscription {
                id
                topic
                callbackUrl
            }

            userErrors {
                field
                message
            }
        }
    }
    `;


    const data = await shopifyGraphQL(mutation);


    console.log(
        "[SHOPIFY][WEBHOOK][CREATE]",
        JSON.stringify(data, null, 2)
    );


    return data.webhookSubscriptionCreate;
}

async function createOrdersUpdatedWebhook() {

    const mutation = `
    mutation CreateOrdersUpdatedWebhook {
        webhookSubscriptionCreate(
            topic: ORDERS_UPDATED,
            webhookSubscription: {
                callbackUrl: "https://api.lngmerch.co/api/shopify/webhooks/orders-updated",
                format: JSON
            }
        ) {
            webhookSubscription {
                id
                topic
                callbackUrl
            }

            userErrors {
                field
                message
            }
        }
    }
    `;


    const data = await shopifyGraphQL(mutation);


    console.log(
        "[SHOPIFY][WEBHOOK][UPDATED]",
        JSON.stringify(data, null, 2)
    );


    return data.webhookSubscriptionCreate;
}


module.exports = {
    createOrdersCreateWebhook,
    createOrdersUpdatedWebhook,
};
