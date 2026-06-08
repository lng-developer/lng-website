require("dotenv").config();

const axios = require("axios");
const db = require("../src/models");

const COUNTRY_RE = /^(us|usa|united states|united states of america)$/i;

const parseArgs = () => {
    const args = process.argv.slice(2);
    const out = {
        dryRun: false,
        latest: false,
        limit: 0,
        orderId: "",
        shopId: "",
        delayMs: Number(process.env.ETSY_ADDRESS_BACKFILL_DELAY_MS || 100),
    };

    for (const arg of args) {
        if (arg === "--dry-run") out.dryRun = true;
        if (arg === "--latest") out.latest = true;
        if (arg.startsWith("--limit=")) out.limit = Number(arg.slice("--limit=".length)) || 0;
        if (arg.startsWith("--orderId=")) out.orderId = String(arg.slice("--orderId=".length)).trim();
        if (arg.startsWith("--shopId=")) out.shopId = String(arg.slice("--shopId=".length)).trim();
        if (arg.startsWith("--delay-ms=")) out.delayMs = Number(arg.slice("--delay-ms=".length)) || 0;
    }

    return out;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const last4 = (value) => {
    const text = String(value || "");
    return text ? text.slice(-4) : "";
};

const getEtsySmartyEnv = () => {
    const authId = process.env.ETSY_US_STREET_SMARTY_AUTH_ID;
    const authToken = process.env.ETSY_US_STREET_SMARTY_AUTH_TOKEN;
    const license = String(process.env.ETSY_US_STREET_SMARTY_LICENSE || "").trim() || undefined;
    const configuredTimeout = Number(process.env.ETSY_US_STREET_SMARTY_TIMEOUT_MS || 15000);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 15000;

    return {
        authId,
        authToken,
        license,
        timeoutMs,
        hasAuthId: !!authId,
        hasAuthToken: !!authToken,
        hasLicense: !!license,
        authIdLast4: last4(authId),
        authTokenLast4: last4(authToken),
        envSource: "ETSY_US_STREET_SMARTY_*",
    };
};

const buildAddress = (shipping = {}) => ({
    street: String(shipping.address1 || "").trim(),
    street2: String(shipping.address2 || "").trim(),
    city: String(shipping.city || "").trim(),
    state: String(shipping.state || "").trim(),
    zipcode: String(shipping.zipcode || "").trim(),
});

const buildResult = ({
    status,
    isValid,
    httpStatus = null,
    errorCode = null,
    errorMessage = null,
    retryable = false,
    accountIssue = false,
    request,
    smartyResponse = null,
}) => ({
    provider: "smarty",
    scope: "etsy_us_street",
    envSource: "ETSY_US_STREET_SMARTY_*",
    status,
    isValid,
    checkedAt: new Date(),
    httpStatus,
    errorCode,
    errorMessage,
    retryable,
    accountIssue,
    request,
    smartyResponse,
});

const getSmartyDpvMatchCode = (candidate = {}) => (
    String(candidate?.analysis?.dpv_match_code || "").trim().toUpperCase()
);

const isSmartyCandidateDeliverable = (candidate = {}) => (
    getSmartyDpvMatchCode(candidate) === "Y"
);

const shouldPreserveExistingAddressValidation = (current, next) => {
    if (!current || !next) return false;
    if (current.status !== "valid" || current.isValid !== true) return false;
    return next.isValid === null && [
        "credentials_missing",
        "auth_error",
        "subscription_error",
        "rate_limit",
        "service_error",
        "unexpected_status",
    ].includes(next.status);
};

const validateOrderAddress = async (order, env) => {
    const address = buildAddress(order.shipping || {});
    const request = {
        orderId: order.orderId || null,
        shopId: order.shopId ? String(order.shopId) : null,
        address,
    };

    if (!env.hasAuthId || !env.hasAuthToken) {
        return buildResult({
            status: "credentials_missing",
            isValid: null,
            errorCode: "ETSY_SMARTY_CREDENTIALS_MISSING",
            errorMessage: "Missing ETSY_US_STREET_SMARTY_AUTH_ID or ETSY_US_STREET_SMARTY_AUTH_TOKEN",
            accountIssue: true,
            request,
        });
    }

    const missingFields = Object.entries(address)
        .filter(([field, value]) => field !== "street2" && !value)
        .map(([field]) => field);

    if (missingFields.length > 0) {
        return buildResult({
            status: "invalid",
            isValid: false,
            errorCode: "SMARTY_ADDRESS_FIELDS_MISSING",
            errorMessage: "Missing required address fields",
            request,
            smartyResponse: { missingFields, request },
        });
    }

    const params = {
        "auth-id": env.authId,
        "auth-token": env.authToken,
        street: address.street,
        city: address.city,
        state: address.state,
        zipcode: address.zipcode,
        candidates: 10,
    };
    if (address.street2) params.street2 = address.street2;
    if (env.license) params.license = env.license;

    try {
        const response = await axios.get("https://us-street.api.smarty.com/street-address", {
            timeout: env.timeoutMs,
            validateStatus: () => true,
            params,
        });
        const data = response.data;

        if (response.status === 200 && Array.isArray(data) && data.length > 0) {
            const firstCandidate = data[0];
            const dpvMatchCode = getSmartyDpvMatchCode(firstCandidate);
            if (!isSmartyCandidateDeliverable(firstCandidate)) {
                return buildResult({
                    status: "invalid",
                    isValid: false,
                    httpStatus: 200,
                    errorCode: "SMARTY_DPV_NOT_CONFIRMED",
                    errorMessage: `Smarty candidate DPV is not confirmed${dpvMatchCode ? ` (${dpvMatchCode})` : ""}`,
                    request,
                    smartyResponse: {
                        firstCandidate,
                        candidatesCount: data.length,
                        rawCandidates: data,
                    },
                });
            }

            return buildResult({
                status: "valid",
                isValid: true,
                httpStatus: 200,
                request,
                smartyResponse: {
                    firstCandidate,
                    candidatesCount: data.length,
                    rawCandidates: data,
                },
            });
        }

        if (response.status === 200) {
            return buildResult({
                status: "invalid",
                isValid: false,
                httpStatus: 200,
                errorCode: "SMARTY_NO_CANDIDATES",
                errorMessage: "Smarty returned no candidates",
                request,
                smartyResponse: {
                    rawCandidates: Array.isArray(data) ? data : [],
                    candidatesCount: 0,
                    request,
                },
            });
        }

        const statusMap = {
            401: ["auth_error", "SMARTY_AUTH_ERROR", false, true],
            402: ["subscription_error", "SMARTY_SUBSCRIPTION_REQUIRED", false, true],
            429: ["rate_limit", "SMARTY_RATE_LIMIT", true, false],
        };
        const mapped = statusMap[response.status] || (
            response.status >= 500
                ? ["service_error", "SMARTY_SERVICE_ERROR", true, false]
                : ["unexpected_status", "SMARTY_UNEXPECTED_STATUS", true, false]
        );

        return buildResult({
            status: mapped[0],
            isValid: null,
            httpStatus: response.status,
            errorCode: mapped[1],
            errorMessage: "Smarty returned an error status",
            retryable: mapped[2],
            accountIssue: mapped[3],
            request,
            smartyResponse: data || null,
        });
    } catch (err) {
        return buildResult({
            status: "service_error",
            isValid: null,
            errorCode: "SMARTY_NETWORK_ERROR",
            errorMessage: err.message,
            retryable: true,
            accountIssue: false,
            request,
            smartyResponse: {
                message: err.message,
                code: err.code || null,
            },
        });
    }
};

const main = async () => {
    const args = parseArgs();
    const env = getEtsySmartyEnv();
    const query = { "shipping.country": { $exists: true, $ne: null } };
    if (args.orderId) query.orderId = args.orderId;
    if (args.shopId) query.shopId = args.shopId;
    const stats = {
        scanned: 0,
        eligibleUs: 0,
        updated: 0,
        skippedNonUs: 0,
        byStatus: {},
    };

    await db.connectDB();

    console.log("[ETSY_ADDRESS_BACKFILL] start", {
        dryRun: args.dryRun,
        latest: args.latest,
        limit: args.limit || null,
        orderId: args.orderId || null,
        shopId: args.shopId || null,
        delayMs: args.delayMs,
        envSource: env.envSource,
        hasAuthId: env.hasAuthId,
        hasAuthToken: env.hasAuthToken,
        hasLicense: env.hasLicense,
        authIdLast4: env.authIdLast4,
        authTokenLast4: env.authTokenLast4,
    });

    const cursor = db.EtsyOrder.find(query)
        .select({ orderId: 1, shopId: 1, shipping: 1 })
        .sort(args.latest ? { createdAt: -1, _id: -1 } : { createdAt: 1, _id: 1 })
        .cursor();

    for await (const order of cursor) {
        if (args.limit && stats.eligibleUs >= args.limit) break;

        stats.scanned += 1;
        if (!COUNTRY_RE.test(String(order.shipping?.country || "").trim())) {
            stats.skippedNonUs += 1;
            continue;
        }

        stats.eligibleUs += 1;
        const result = await validateOrderAddress(order, env);
        stats.byStatus[result.status] = (stats.byStatus[result.status] || 0) + 1;

        if (!args.dryRun) {
            if (shouldPreserveExistingAddressValidation(order.address_validation, result)) {
                stats.preserved = (stats.preserved || 0) + 1;
            } else {
                order.address_validation = result;
                await order.save();
                stats.updated += 1;
            }
        }

        if (stats.eligibleUs % 25 === 0) {
            console.log("[ETSY_ADDRESS_BACKFILL] progress", stats);
        }

        if (args.delayMs > 0) await sleep(args.delayMs);
    }

    console.log("[ETSY_ADDRESS_BACKFILL] done", stats);
    await db.mongoose.disconnect();
};

main().catch(async (err) => {
    console.error("[ETSY_ADDRESS_BACKFILL] failed", err);
    try {
        await db.mongoose.disconnect();
    } catch (_) {
        // ignore disconnect errors
    }
    process.exit(1);
});
