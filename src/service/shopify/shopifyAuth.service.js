const crypto = require("crypto");
const axios = require("axios");
const db = require("../../models");

const SHOPIFY_OAUTH_SCOPES = [
    "read_customers",
    "read_orders",
    "read_products",
    "read_fulfillments",
    "write_fulfillments",
    "read_merchant_managed_fulfillment_orders",
    "write_merchant_managed_fulfillment_orders",
];

const STATE_TTL_MS = 10 * 60 * 1000;
const stateCache = new Map();

function getRequiredEnv() {
    const clientId = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
    const clientSecret = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();

    const missing = [];
    if (!clientId) missing.push("SHOPIFY_CLIENT_ID");
    if (!clientSecret) missing.push("SHOPIFY_CLIENT_SECRET");

    if (missing.length) {
        const err = new Error(`Missing Shopify env: ${missing.join(", ")}`);
        err.code = "SHOPIFY_ENV_MISSING";
        throw err;
    }

    return { clientId, clientSecret };
}

function normalizeShopDomain(shop) {
    const shopDomain = String(shop || process.env.SHOPIFY_SHOP_DOMAIN || "").trim().toLowerCase();
    if (!shopDomain) {
        const err = new Error("Missing Shopify shop domain");
        err.code = "SHOPIFY_SHOP_MISSING";
        throw err;
    }

    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
        const err = new Error("Invalid Shopify shop domain");
        err.code = "SHOPIFY_SHOP_INVALID";
        throw err;
    }

    return shopDomain;
}

function getRedirectUri() {
    const explicitRedirectUri = String(process.env.SHOPIFY_OAUTH_REDIRECT_URI || "").trim();
    if (explicitRedirectUri) return explicitRedirectUri;

    const appUrl = String(process.env.SHOPIFY_APP_URL || "").trim().replace(/\/+$/, "");
    if (!appUrl) {
        const err = new Error("Missing Shopify env: SHOPIFY_OAUTH_REDIRECT_URI");
        err.code = "SHOPIFY_ENV_MISSING";
        throw err;
    }

    return appUrl.endsWith("/auth") ? `${appUrl}/callback` : `${appUrl}/auth/callback`;
}

function createOAuthState(shopDomain) {
    const state = crypto.randomBytes(24).toString("hex");
    stateCache.set(state, {
        shopDomain,
        expiresAt: Date.now() + STATE_TTL_MS,
    });
    return state;
}

function consumeOAuthState(state, shopDomain) {
    const cached = stateCache.get(state);
    stateCache.delete(state);

    if (!cached || cached.expiresAt < Date.now() || cached.shopDomain !== shopDomain) {
        const err = new Error("Invalid Shopify OAuth state");
        err.code = "SHOPIFY_OAUTH_STATE_INVALID";
        throw err;
    }
}

function splitScopes(scope = "") {
    return String(scope || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function generateShopifyInstallUrl(shop) {
    const shopDomain = normalizeShopDomain(shop);
    const { clientId } = getRequiredEnv();
    const state = createOAuthState(shopDomain);
    const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);

    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SHOPIFY_OAUTH_SCOPES.join(","));
    url.searchParams.set("redirect_uri", getRedirectUri());
    url.searchParams.set("state", state);

    console.log("[SHOPIFY][OAUTH][START]", {
        shop: shopDomain,
        scopes: SHOPIFY_OAUTH_SCOPES,
    });

    return url.toString();
}

async function exchangeShopifyOAuthCode({ shop, code, state }) {
    const shopDomain = normalizeShopDomain(shop);
    const { clientId, clientSecret } = getRequiredEnv();

    if (!code) {
        const err = new Error("Missing Shopify OAuth code");
        err.code = "SHOPIFY_OAUTH_CODE_MISSING";
        throw err;
    }
    if (!state) {
        const err = new Error("Missing Shopify OAuth state");
        err.code = "SHOPIFY_OAUTH_STATE_MISSING";
        throw err;
    }

    consumeOAuthState(state, shopDomain);

    const response = await axios.post(
        `https://${shopDomain}/admin/oauth/access_token`,
        {
            client_id: clientId,
            client_secret: clientSecret,
            code,
        },
        {
            headers: { "Content-Type": "application/json" },
            timeout: 20000,
            validateStatus: () => true,
        }
    );

    if (response.status < 200 || response.status >= 300) {
        const err = new Error(`Shopify OAuth token request failed with status ${response.status}`);
        err.code = "SHOPIFY_OAUTH_TOKEN_REQUEST_FAILED";
        err.httpStatus = response.status;
        throw err;
    }

    const data = response.data || {};
    if (!data.access_token) {
        const err = new Error("Shopify OAuth token response missing access_token");
        err.code = "SHOPIFY_OAUTH_TOKEN_RESPONSE_INVALID";
        throw err;
    }

    const scopes = splitScopes(data.scope);
    await db.shopifyStore.findOneAndUpdate(
        { shopDomain },
        {
            $set: {
                shopDomain,
                accessToken: data.access_token,
                scopes,
                updatedAt: new Date(),
            },
            $setOnInsert: {
                installedAt: new Date(),
            },
        },
        { new: true, upsert: true }
    );

    console.log("[SHOPIFY][OAUTH][TOKEN_CREATED]", {
        shop: shopDomain,
        scope: data.scope || "",
    });

    return {
        shopDomain,
        accessToken: data.access_token,
        scope: data.scope || "",
        scopes,
    };
}

async function getShopifyAccessToken(shop) {
    const shopDomain = normalizeShopDomain(shop);

    const store = await db.shopifyStore.findOne({ shopDomain });
    if (store?.accessToken) return store.accessToken;

    const fallbackToken = String(process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
    if (fallbackToken) return fallbackToken;

    const err = new Error("Missing Shopify access token. Install Shopify OAuth app first.");
    err.code = "SHOPIFY_ACCESS_TOKEN_MISSING";
    throw err;
}

module.exports = {
    SHOPIFY_OAUTH_SCOPES,
    generateShopifyInstallUrl,
    exchangeShopifyOAuthCode,
    getShopifyAccessToken,
};
