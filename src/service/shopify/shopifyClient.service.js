const axios = require("axios");
const { getShopifyAccessToken } = require("./shopifyAuth.service");

function getShopifyClientEnv() {
    const shopDomain = String(process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
    const apiVersion = String(process.env.SHOPIFY_API_VERSION || "2026-04").trim();

    const missing = [];
    if (!shopDomain) missing.push("SHOPIFY_SHOP_DOMAIN");
    if (!apiVersion) missing.push("SHOPIFY_API_VERSION");

    if (missing.length) {
        const err = new Error(`Missing Shopify env: ${missing.join(", ")}`);
        err.code = "SHOPIFY_ENV_MISSING";
        throw err;
    }

    return { shopDomain, apiVersion };
}

function buildGraphQLErrorMessage(errors = []) {
    if (!Array.isArray(errors) || errors.length === 0) return "Shopify GraphQL returned errors";
    return errors
        .map((error) => error?.message || String(error))
        .filter(Boolean)
        .join("; ") || "Shopify GraphQL returned errors";
}

async function shopifyGraphQL(query, variables = {}) {
    const { shopDomain, apiVersion } = getShopifyClientEnv();
    const accessToken = await getShopifyAccessToken();
    const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

    try {
        const response = await axios.post(
            url,
            { query, variables },
            {
                headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": accessToken,
                },
                timeout: 30000,
                validateStatus: () => true,
            }
        );

        if (response.status < 200 || response.status >= 300) {
            const err = new Error(`Shopify GraphQL request failed with status ${response.status}`);
            err.code = "SHOPIFY_GRAPHQL_HTTP_ERROR";
            err.httpStatus = response.status;
            throw err;
        }

        const payload = response.data || {};
        if (Array.isArray(payload.errors) && payload.errors.length > 0) {
            const err = new Error(buildGraphQLErrorMessage(payload.errors));
            err.code = "SHOPIFY_GRAPHQL_ERRORS";
            err.shopifyErrors = payload.errors;
            throw err;
        }

        return payload.data;
    } catch (err) {
        console.error("[SHOPIFY][GRAPHQL] request failed", {
            message: err.message,
            code: err.code || null,
            httpStatus: err.httpStatus || null,
        });
        throw err;
    }
}

module.exports = {
    shopifyGraphQL,
};
