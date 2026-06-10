const axios = require("axios");

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

let tokenCache = {
    accessToken: "",
    scope: "",
    expiresAt: 0,
};

function getShopifyAuthEnv() {
    const shopDomain = String(process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
    const clientId = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
    const clientSecret = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();

    const missing = [];
    if (!shopDomain) missing.push("SHOPIFY_SHOP_DOMAIN");
    if (!clientId) missing.push("SHOPIFY_CLIENT_ID");
    if (!clientSecret) missing.push("SHOPIFY_CLIENT_SECRET");

    if (missing.length) {
        const err = new Error(`Missing Shopify env: ${missing.join(", ")}`);
        err.code = "SHOPIFY_ENV_MISSING";
        throw err;
    }

    return { shopDomain, clientId, clientSecret };
}

function isCachedTokenUsable() {
    return (
        !!tokenCache.accessToken &&
        Number(tokenCache.expiresAt || 0) - Date.now() > TOKEN_REFRESH_BUFFER_MS
    );
}

async function requestNewAccessToken() {
    const { shopDomain, clientId, clientSecret } = getShopifyAuthEnv();
    const url = `https://${shopDomain}/admin/oauth/access_token`;
    const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
    });

    try {
        const response = await axios.post(url, body.toString(), {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout: 20000,
            validateStatus: () => true,
        });

        if (response.status < 200 || response.status >= 300) {
            const err = new Error(`Shopify token request failed with status ${response.status}`);
            err.code = "SHOPIFY_TOKEN_REQUEST_FAILED";
            err.httpStatus = response.status;
            throw err;
        }

        const data = response.data || {};
        if (!data.access_token) {
            const err = new Error("Shopify token response missing access_token");
            err.code = "SHOPIFY_TOKEN_RESPONSE_INVALID";
            throw err;
        }

        const expiresInSeconds = Number(data.expires_in || 0);
        tokenCache = {
            accessToken: data.access_token,
            scope: String(data.scope || ""),
            expiresAt: Date.now() + Math.max(expiresInSeconds, 1) * 1000,
        };

        return tokenCache.accessToken;
    } catch (err) {
        console.error("[SHOPIFY][AUTH] token request failed", {
            message: err.message,
            code: err.code || null,
            httpStatus: err.httpStatus || null,
        });
        throw err;
    }
}

async function getShopifyAccessToken() {
    if (isCachedTokenUsable()) return tokenCache.accessToken;
    return requestNewAccessToken();
}

module.exports = {
    getShopifyAccessToken,
    requestNewAccessToken,
};
