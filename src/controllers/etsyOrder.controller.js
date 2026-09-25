const db = require('../models');
const mongoose = require('mongoose');
const EtsyOrder = db.EtsyOrder;
const OrderHistory = db.OrderHistory;
const EtsyListing = require('../models/etsyListing.model');
const User = db.user;
const Role = db.role;
const Store = db.shop;
const SkuMappingConfig = db.SkuMappingConfig;

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const axios = require('axios');
const multer = require("multer");
const { uploadBufferToR2, uploadFilePathToR2 } = require("../service/cloudflareR2/r2.service");
const FulfillmentService = require("../service/fulfillment");
const { logOrderHistory } = require("../service/orderHistoryLogger");
const { logOrderLifecycleEvent } = require("../service/orderLifecycleLogger");
const { buildOrderLifecyclePayload } = require("../service/orderLifecycleContext");
const {
    buildEtsyTrackingInfoResponse,
    buildEtsyTrackingSummary,
} = require("../service/etsyTrackingResponse.service");
const ExtensionTask = require("../models/extensionTask.model");
const { buildTaskId, emitTaskToMachine } = require("../lib/taskEmitter");
const logger = require("../helper/logger");
const {
    applyRulesToSku,
    buildRulesFromConfig,
} = require("../utils/skuMigrate");

const etsyFulfillmentUploadDir = path.join(process.cwd(), "tmp_uploads", "etsy_fulfillment");
if (!fs.existsSync(etsyFulfillmentUploadDir)) fs.mkdirSync(etsyFulfillmentUploadDir, { recursive: true });

const etsyScaleUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, etsyFulfillmentUploadDir),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname || "");
            cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
        },
    }),
    limits: {
        fileSize: Number(process.env.ETSY_FULFILLMENT_FILE_MAX_BYTES || 1024 * 1024 * 1024),
    },
});

/* ================== UTIL ================== */

const toBooleanStrict = (value) => {
    if (value === true || value === false) return value;
    if (String(value).toLowerCase() === "true") return true;
    if (String(value).toLowerCase() === "false") return false;
    return null;
};

const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ETSY_LIST_SELECT_FIELDS = [
    "orderId",
    "shopId",
    "saleDate",
    "createdAt",
    "status",
    "shipping_type",
    "buyer",
    "shipping",
    "seller",
    "items",
    "base_cost",
    "manual_vendor_required",
    "numberOfItems",
    "case",
    "address_validation",
    "vendor_submissions",
    "sumbittedoetsy",
].join(" ");

const ETSY_TRACKING_STATUSES = ["New", "In progress", "Fulfilled", "Shipping", "Shipped", "Canceled", "Cancelled"];
const isEtsyCanceledStatus = (status) => ["Canceled", "Cancelled"].includes(String(status || "").trim());
const ETSY_ADDRESS_UNCHECKED_MATCH = {
    "address_validation.isValid": null,
    status: { $nin: ["Cancelled", "Canceled"] },
};

const etsyShippingFilterValue = (value) => {
    if (!value) return null;
    return value === "Second Day" ? { $in: ["Second Day", "SecondDay"] } : value;
};

async function buildEtsyOrderFilter(query = {}, { includeTabFilters = true } = {}) {
    const {
        from,
        to,
        search,
        userNull,
        noPsd,
        shippingType,
        shipping_type,
        shopName,
        teamId,
        vendorId,
        vendor,
        openCase,
        status,
        statuses,
        isNoCostCenter,
        invalidAddress,
        addressUnchecked,
        sumbittedoetsy,
        submittedToEtsy,
    } = query;

    const filter = {};

    const statusFilter = statuses || status;
    if (includeTabFilters && statusFilter) {
        const statusArray = String(statusFilter).split(",").map(s => s.trim()).filter(Boolean);
        if (statusArray.length === 1) filter.status = statusArray[0];
        if (statusArray.length > 1) filter.status = { $in: statusArray };
    }
    const shippingValue = etsyShippingFilterValue(shippingType || shipping_type);
    if (shippingValue) filter.shipping_type = shippingValue;

    if (shopName && String(shopName).trim()) {
        const shopNameRegex = new RegExp(escapeRegExp(String(shopName).trim()), "i");
        const shops = await Store.find({
            $or: [
                { name: shopNameRegex },
                { store: shopNameRegex },
            ],
        }).select("_id").lean();
        filter.shopId = { $in: shops.map(s => s._id) };
    }

    if (teamId) {
        const teamShops = await Store.find({ team: teamId }).select("_id").lean();
        const teamShopIds = teamShops.map(s => s._id);
        if (filter.shopId) {
            const existing = filter.shopId.$in || [filter.shopId];
            filter.shopId = { $in: existing.filter(id => teamShopIds.some(tid => String(tid) === String(id))) };
        } else {
            filter.shopId = { $in: teamShopIds };
        }
    }

    const selectedVendorId = vendorId || vendor;
    if (selectedVendorId) {
        if (!mongoose.Types.ObjectId.isValid(selectedVendorId)) {
            const error = new Error("Invalid vendorId");
            error.statusCode = 400;
            throw error;
        }

        const vendorProducts = await db.vendorProduct
            .find({ vendor_id: new mongoose.Types.ObjectId(selectedVendorId) })
            .select("_id")
            .lean();
        const vendorProductIds = vendorProducts.map(vp => vp._id).filter(Boolean);
        filter["items.cost_breakdown.vendorProductId"] = {
            $in: vendorProductIds.flatMap(id => [id, String(id)]),
        };
    }

    if (userNull === "true") {
        filter["seller.sellerId"] = { $in: [null, undefined] };
    }

    if (from || to) {
        filter.saleDate = {};
        if (from) filter.saleDate.$gte = new Date(from);
        if (to) filter.saleDate.$lte = new Date(to);
    }

    if (search) {
        const keyword = String(search).trim();
        if (/^\d{5,}$/.test(keyword)) {
            filter.orderId = keyword;
        } else if (keyword) {
            const regex = new RegExp(escapeRegExp(keyword), "i");
            filter.$or = [
                { orderId: regex },
                { "buyer.fullName": regex },
                { "buyer.userId": regex },
                { "items.sku": regex },
                { "items.itemName": regex },
                { "items.transactionId": regex },
                { "seller.sellerCode": regex },
                { "shipping.city": regex },
                { "shipping.state": regex },
                { "shipping.country": regex },
            ];
        }
    }

    const submittedFilter = sumbittedoetsy ?? submittedToEtsy;
    if (submittedFilter === "true" || submittedFilter === true) filter.sumbittedoetsy = true;
    if (submittedFilter === "false" || submittedFilter === false) filter.sumbittedoetsy = false;

    if (!includeTabFilters) return filter;

    if (isNoCostCenter === "true") {
        filter.$and = [
            ...(filter.$and || []),
            {
                $or: [
                    { base_cost: { $exists: false } },
                    { base_cost: null },
                    { base_cost: 0 },
                ],
            },
            { status: { $ne: "Cancelled" } },
        ];
    }

    if (toBooleanStrict(invalidAddress) === true) {
        filter["address_validation.isValid"] = false;
    }

    if (toBooleanStrict(addressUnchecked) === true) {
        Object.assign(filter, ETSY_ADDRESS_UNCHECKED_MATCH);
    }

    if (toBooleanStrict(openCase) === true) {
        filter.case = { $exists: true, $ne: [] };
    }

    if (toBooleanStrict(noPsd) === true) {
        filter.$and = [
            ...(filter.$and || []),
            { "items.snapshotImage": { $in: [null, ""] } },
            { status: { $ne: "Cancelled" } },
        ];
    }

    return filter;
}

function computeEtsyOrderStatusFromItems(items = []) {
    const statuses = (items || []).map((item) => String(item?.tracking_info?.status || "New").trim());
    const active = statuses.filter((status) => !isEtsyCanceledStatus(status));
    if (active.length === 0 && statuses.length > 0) return "Cancelled";
    if (active.length > 0 && active.every((status) => status === "Shipped")) return "Shipped";
    if (active.includes("Shipping")) return "Shipping";
    if (active.includes("Fulfilled")) return "Fulfilled";
    if (active.includes("In progress")) return "In progress";
    return "New";
}

const toNumber = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    const cleaned = s.replace(/[^0-9.\-]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
};

const toInt = (v) => {
    const n = toNumber(v);
    return n === null ? null : Math.trunc(n);
};

const toDate = (v) => {
    if (!v) return null;
    const d = new Date(String(v).trim());
    return Number.isNaN(d.getTime()) ? null : d;
};

const decodeEtsyHtmlEntities = (value) => {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&#(\d+);/g, (_match, code) => {
            const point = Number(code);
            if (!Number.isFinite(point) || point < 0 || point > 0x10FFFF) return _match;
            return String.fromCodePoint(point);
        })
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
            const point = Number.parseInt(code, 16);
            if (!Number.isFinite(point) || point < 0 || point > 0x10FFFF) return _match;
            return String.fromCodePoint(point);
        })
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
};

const normalizeEtsyTextValue = (value) => decodeEtsyHtmlEntities(String(value ?? "").trim());

const normalizeEtsyVariationObject = (variations = {}) => {
    if (!variations || typeof variations !== "object" || Array.isArray(variations)) return {};
    return Object.fromEntries(
        Object.entries(variations).map(([key, value]) => [
            normalizeEtsyTextValue(key),
            normalizeEtsyTextValue(value),
        ])
    );
};

function decodeEtsyHtmlEntitiesInObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, raw]) => [
            key,
            typeof raw === "string" ? decodeEtsyHtmlEntities(raw) : raw,
        ])
    );
}

const parseVariations = (raw) => {
    if (!raw) return {};
    const out = {};
    const parts = String(raw).split(',').map(x => x.trim()).filter(Boolean);
    for (const p of parts) {
        const idx = p.indexOf(':');
        if (idx === -1) continue;
        out[normalizeEtsyTextValue(p.slice(0, idx))] = normalizeEtsyTextValue(p.slice(idx + 1));
    }
    return out;
};

const readCsv = (filePath) => {
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(parse({ columns: true, skip_empty_lines: true, bom: true }))
            .on('data', row => rows.push(row))
            .on('error', reject)
            .on('end', () => resolve(rows));
    });
};

const detectFileType = (rows) => {
    if (!rows.length) return 'unknown';
    const headers = Object.keys(rows[0]);
    if (headers.includes("Transaction ID")) return "items";
    if (headers.includes("Buyer User ID")) return "orders";
    return "unknown";
};

async function mapOptionValue({ configCode, key, rawValue }) {
    let val = String(rawValue ?? "");
    if (!val) return { value: val, ruleId: null, matchType: null };
    if (!ConfigOptionMapping)
        return { value: val, ruleId: null, matchType: null };

    const rules = await ConfigOptionMapping.find({
        config_code: configCode,
        key,
        active: { $ne: false },
    })
        .sort({ priority: 1, created_at: 1 })
        .lean();

    const n = (x) => String(x || "").trim();
    const nl = (x) => normalize(x);

    for (const r of rules || []) {
        const mt = String(r.match_type || "equals").toLowerCase();
        const flags = r.regex_flags || "i";
        const cs = !!r.case_sensitive;
        const mval = String(r.match_value ?? "");
        const mapped = String(r.mapped_value ?? "");

        try {
            if (mt === "equals") {
                const ok = cs ? n(val) === n(mval) : nl(val) === nl(mval);
                if (ok) return { value: mapped, ruleId: String(r._id), matchType: mt };
            }
            if (mt === "contains") {
                const ok = cs ? n(val).includes(n(mval)) : nl(val).includes(nl(mval));
                if (ok) return { value: mapped, ruleId: String(r._id), matchType: mt };
            }
            if (mt === "regex") {
                const re = new RegExp(mval, flags);
                if (re.test(val))
                    return { value: mapped, ruleId: String(r._id), matchType: mt };
            }
            if (mt === "regex_replace") {
                const re = new RegExp(mval, flags);
                const replaced = val.replace(re, mapped);
                if (replaced !== val)
                    return { value: replaced, ruleId: String(r._id), matchType: mt };
            }
        } catch (_e) {
            /* ignore */
        }
    }
    return { value: val, ruleId: null, matchType: null };
}

/* ================== SELLER LOGIC (GIỮ NGUYÊN) ================== */

const getSellerCodeFromSku = (sku) => {
    if (!sku) return null;
    const s = String(sku).trim();
    if (!s) return null;
    const first = s.split('-')[0]?.trim();
    if (!first) return null;
    return first;
};

const loadActiveEtsySkuMappingConfigs = async () => {
    if (!SkuMappingConfig?.find) return [];

    const now = new Date();
    return SkuMappingConfig.find({
        is_active: true,
        $and: [
            { $or: [{ valid_from: null }, { valid_from: { $lte: now } }] },
            { $or: [{ valid_to: null }, { valid_to: { $gte: now } }] },
        ],
    })
        .sort({ priority: 1, createdAt: 1 })
        .lean();
};

const resolveMappedSkuFromConfigs = (sku, configs = []) => {
    if (!sku || !Array.isArray(configs) || configs.length === 0) return null;

    for (const cfg of configs) {
        const rules = buildRulesFromConfig(cfg);
        const result = applyRulesToSku(sku, rules);
        if (result.ok && result.changed) {
            return {
                mapped_sku: result.next,
                config: cfg,
                rulesSnapshot: rules,
            };
        }
    }

    return null;
};

const fillSellerIfMissing = async (orderId, shopId, sellerCode) => {
    if (!sellerCode) return;

    const user = await User.findOne({ employee_id: sellerCode })
        .select('_id employee_id')
        .lean();

    const missing = (field) => ({
        $or: [
            { $eq: [{ $ifNull: [field, null] }, null] },
            { $eq: [field, ""] }
        ]
    });

    const pipeline = [{
        $set: {
            "seller.sellerCode": {
                $cond: [missing("$seller.sellerCode"), sellerCode, "$seller.sellerCode"]
            },
            "seller.sellerId": user?._id
                ? { $cond: [missing("$seller.sellerId"), user._id, "$seller.sellerId"] }
                : "$seller.sellerId",
        }
    }];

    await EtsyOrder.updateOne({ orderId, shopId }, pipeline, { upsert: true });
};

/* ================== ADDRESS VALIDATION ================== */

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

const buildSmartyDebugAddress = (address = {}) => ({
    street: String(address.address || address.street || "").trim(),
    street2: String(address.address_2 || address.street2 || "").trim(),
    city: String(address.city || "").trim(),
    state: String(address.state || "").trim(),
    zipcode: String(address.zip_code || address.zipcode || "").trim(),
});

const logEtsySmartyAddressValidation = (message, details = {}) => {
    logger.warn({
        tag: "ETSY_SMARTY_ADDRESS_VALIDATION",
        message,
        ...details,
    });
};

const buildEtsySmartyValidationResult = ({
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

const getAcceptedSmartyDpvMatchCodes = () => (
    String(process.env.ETSY_SMARTY_ACCEPT_DPV_CODES || "Y,S,D")
        .split(",")
        .map((code) => code.trim().toUpperCase())
        .filter(Boolean)
);

const isSmartyCandidateDeliverable = (candidate = {}) => (
    getAcceptedSmartyDpvMatchCodes().includes(getSmartyDpvMatchCode(candidate))
);

const isUsShippingCountry = (country) => {
    const normalized = String(country || "").trim().toLowerCase().replace(/\./g, "");
    return ["us", "usa", "united states", "united states of america"].includes(normalized);
};

const isConfirmedInvalidAddress = (addressValidation) => (
    addressValidation?.isValid === false &&
    (
        addressValidation?.status === "invalid" ||
        !addressValidation?.status
    )
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

const validateAddressWithSmarty = async (address, context = {}) => {
    const env = getEtsySmartyEnv();
    const debugAddress = buildSmartyDebugAddress(address);
    const request = {
        orderId: context.orderId || null,
        shopId: context.shopId ? String(context.shopId) : null,
        address: debugAddress,
    };
    const logContext = {
        orderId: request.orderId,
        shopId: request.shopId,
        address: debugAddress,
        authIdLast4: env.authIdLast4,
        authTokenLast4: env.authTokenLast4,
        hasLicense: env.hasLicense,
    };

    if (!env.hasAuthId || !env.hasAuthToken) {
        const result = buildEtsySmartyValidationResult({
            status: "credentials_missing",
            isValid: null,
            errorCode: "ETSY_SMARTY_CREDENTIALS_MISSING",
            errorMessage: "Missing ETSY_US_STREET_SMARTY_AUTH_ID or ETSY_US_STREET_SMARTY_AUTH_TOKEN",
            accountIssue: true,
            request,
        });
        logEtsySmartyAddressValidation("Missing Etsy Smarty credentials", {
            ...logContext,
            status: result.status,
            errorCode: result.errorCode,
        });
        return result;
    }

    const missingFields = Object.entries(debugAddress)
        .filter(([field, value]) => field !== "street2" && !value)
        .map(([field]) => field);
    if (missingFields.length > 0) {
        const result = buildEtsySmartyValidationResult({
            status: "invalid",
            isValid: false,
            errorCode: "SMARTY_ADDRESS_FIELDS_MISSING",
            errorMessage: "Missing required address fields",
            request,
            smartyResponse: {
                missingFields,
                request,
            },
        });
        logEtsySmartyAddressValidation("Missing required address fields", {
            ...logContext,
            status: result.status,
            errorCode: result.errorCode,
            missingFields,
        });
        return result;
    }

    const params = {
        "auth-id": env.authId,
        "auth-token": env.authToken,
        street: debugAddress.street,
        city: debugAddress.city,
        state: debugAddress.state,
        zipcode: debugAddress.zipcode,
        candidates: 10,
    };
    if (debugAddress.street2) params.street2 = debugAddress.street2;
    if (env.license) params.license = env.license;

    try {
        const response = await axios.get(
            "https://us-street.api.smarty.com/street-address",
            {
                timeout: env.timeoutMs,
                validateStatus: () => true,
                params,
            }
        );

        const data = response.data;
        if (Array.isArray(data) && data.length > 0) {
            const firstCandidate = data[0];
            const dpvMatchCode = getSmartyDpvMatchCode(firstCandidate);
            if (!isSmartyCandidateDeliverable(firstCandidate)) {
                const result = buildEtsySmartyValidationResult({
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
                logEtsySmartyAddressValidation("Smarty returned candidates but DPV is not confirmed", {
                    ...logContext,
                    httpStatus: result.httpStatus,
                    status: result.status,
                    errorCode: result.errorCode,
                    dpvMatchCode: dpvMatchCode || null,
                    candidatesCount: data.length,
                });
                return result;
            }

            const result = buildEtsySmartyValidationResult({
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
            logEtsySmartyAddressValidation("Smarty address validation completed", {
                ...logContext,
                httpStatus: result.httpStatus,
                status: result.status,
                candidatesCount: data.length,
            });
            return result;
        }

        if (response.status === 200) {
            const result = buildEtsySmartyValidationResult({
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
            logEtsySmartyAddressValidation("Smarty returned no candidates", {
                ...logContext,
                httpStatus: result.httpStatus,
                status: result.status,
                errorCode: result.errorCode,
            });
            return result;
        }

        const statusMap = {
            401: {
                status: "auth_error",
                errorCode: "SMARTY_AUTH_ERROR",
                retryable: false,
                accountIssue: true,
            },
            402: {
                status: "subscription_error",
                errorCode: "SMARTY_SUBSCRIPTION_REQUIRED",
                retryable: false,
                accountIssue: true,
            },
            429: {
                status: "rate_limit",
                errorCode: "SMARTY_RATE_LIMIT",
                retryable: true,
                accountIssue: false,
            },
        };
        const mapped = statusMap[response.status] || (
            response.status >= 500
                ? {
                    status: "service_error",
                    errorCode: "SMARTY_SERVICE_ERROR",
                    retryable: true,
                    accountIssue: false,
                }
                : {
                    status: "unexpected_status",
                    errorCode: "SMARTY_UNEXPECTED_STATUS",
                    retryable: true,
                    accountIssue: false,
                }
        );
        const result = buildEtsySmartyValidationResult({
            status: mapped.status,
            isValid: null,
            httpStatus: response.status,
            errorCode: mapped.errorCode,
            errorMessage: "Smarty returned an error status",
            retryable: mapped.retryable,
            accountIssue: mapped.accountIssue,
            request,
            smartyResponse: data || null,
        });
        logEtsySmartyAddressValidation("Smarty address validation returned non-200", {
            ...logContext,
            httpStatus: result.httpStatus,
            status: result.status,
            errorCode: result.errorCode,
        });
        return result;
    } catch (err) {
        const result = buildEtsySmartyValidationResult({
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
        logEtsySmartyAddressValidation("Smarty address validation request failed", {
            ...logContext,
            httpStatus: null,
            status: result.status,
            errorCode: result.errorCode,
        });
        return result;
    }
};

const validateAddressIfNeeded = async (orderDoc, { force = false } = {}) => {
    if (!orderDoc) return;

    if (!isUsShippingCountry(orderDoc.shipping?.country)) return;

    const current = orderDoc.address_validation;
    const shouldValidate =
        force ||
        !current ||
        current.status === "pending" ||
        (
            (current.isValid === null || current.isValid === undefined) &&
            !current.status
        );

    if (shouldValidate) {
        const result = await validateAddressWithSmarty({
            address: orderDoc.shipping?.address1,
            address_2: orderDoc.shipping?.address2,
            city: orderDoc.shipping?.city,
            state: orderDoc.shipping?.state,
            zip_code: orderDoc.shipping?.zipcode,
        }, {
            orderId: orderDoc.orderId,
            shopId: orderDoc.shopId,
        });

        if (shouldPreserveExistingAddressValidation(current, result)) {
            logEtsySmartyAddressValidation("Preserved existing valid address validation after Smarty non-address failure", {
                orderId: orderDoc.orderId,
                shopId: orderDoc.shopId ? String(orderDoc.shopId) : null,
                nextStatus: result.status,
                nextErrorCode: result.errorCode,
            });
            return;
        }

        orderDoc.address_validation = result;
        await orderDoc.save();
    }
};

const classifySmartyTestResponse = (status, data) => {
    if (status === 200) {
        return Array.isArray(data) && data.length > 0
            ? { classification: "valid", isValid: true }
            : { classification: "invalid_no_candidates", isValid: false };
    }
    if (status === 401) return { classification: "auth_error", isValid: null };
    if (status === 402) return { classification: "subscription_error", isValid: null };
    if (status === 429) return { classification: "rate_limit", isValid: null };
    if (status >= 500) return { classification: "service_error", isValid: null };
    return { classification: "unexpected_status", isValid: null };
};

const buildEtsySmartyTestEnvLoaded = ({ authId, authToken, license }) => ({
    hasAuthId: !!authId,
    hasAuthToken: !!authToken,
    hasLicense: !!license,
    authIdLast4: last4(authId),
    authTokenLast4: last4(authToken),
});

const testEtsySmartyAddressValidation = async (req, res) => {
    const env = getEtsySmartyEnv();
    const envLoaded = buildEtsySmartyTestEnvLoaded(env);
    const body = req.body || {};
    const requestContext = {
        orderId: body.orderId || null,
        street: String(body.street || "").trim(),
        city: String(body.city || "").trim(),
        state: String(body.state || "").trim(),
        zipcode: String(body.zipcode || "").trim(),
        authIdLast4: envLoaded.authIdLast4,
        authTokenLast4: envLoaded.authTokenLast4,
    };

    if (!env.hasAuthId || !env.hasAuthToken) {
        logger.warn({
            tag: "ETSY_SMARTY_TEST",
            message: "Missing Etsy Smarty credentials",
            ...requestContext,
        });
        return res.json({
            ok: false,
            provider: "smarty",
            scope: "etsy_us_street",
            envSource: "ETSY_US_STREET_SMARTY_*",
            httpStatus: null,
            envLoaded,
            classification: "missing_credentials",
            isValid: null,
            candidatesCount: 0,
            firstCandidate: null,
            smartyError: {
                message: "Missing ETSY_US_STREET_SMARTY_AUTH_ID or ETSY_US_STREET_SMARTY_AUTH_TOKEN",
            },
        });
    }

    const params = {
        "auth-id": env.authId,
        "auth-token": env.authToken,
        street: requestContext.street,
        city: requestContext.city,
        state: requestContext.state,
        zipcode: requestContext.zipcode,
        candidates: 10,
    };
    if (String(body.street2 || "").trim()) params.street2 = String(body.street2).trim();
    if (env.license) params.license = env.license;

    logger.debug({
        tag: "ETSY_SMARTY_TEST",
        message: "Testing Etsy Smarty address validation",
        ...requestContext,
    });

    try {
        const response = await axios.get(
            "https://us-street.api.smarty.com/street-address",
            {
                timeout: env.timeoutMs,
                validateStatus: () => true,
                params,
            }
        );
        const data = response.data;
        const candidatesCount = Array.isArray(data) ? data.length : 0;
        const { classification, isValid } = classifySmartyTestResponse(response.status, data);
        const smartyError = classification === "valid" || classification === "invalid_no_candidates"
            ? null
            : data || { message: "Unexpected Smarty response status" };

        logger.debug({
            tag: "ETSY_SMARTY_TEST",
            message: "Smarty test completed",
            ...requestContext,
            httpStatus: response.status,
            classification,
            candidatesCount,
        });

        return res.json({
            ok: classification === "valid" || classification === "invalid_no_candidates",
            provider: "smarty",
            scope: "etsy_us_street",
            envSource: "ETSY_US_STREET_SMARTY_*",
            httpStatus: response.status,
            envLoaded,
            classification,
            isValid,
            candidatesCount,
            firstCandidate: candidatesCount > 0 ? data[0] : null,
            smartyError,
        });
    } catch (err) {
        logger.warn({
            tag: "ETSY_SMARTY_TEST",
            message: "Smarty test request failed",
            ...requestContext,
            error: err.message,
        });
        return res.json({
            ok: false,
            provider: "smarty",
            scope: "etsy_us_street",
            envSource: "ETSY_US_STREET_SMARTY_*",
            httpStatus: null,
            envLoaded,
            classification: "service_error",
            isValid: null,
            candidatesCount: 0,
            firstCandidate: null,
            smartyError: {
                message: err.message,
                code: err.code || null,
            },
        });
    }
};

/* ================== CONTROLLER ================== */

const importOrders = async (req, res) => {
    try {

        const { shopId } = req.body;

        if (!shopId || !mongoose.Types.ObjectId.isValid(shopId)) {
            return res.status(400).json({ message: "Valid shopId is required" });
        }

        if (!req.files?.length) {
            return res.status(400).json({ message: "No files uploaded" });
        }

        const stats = {
            ordersUpserted: 0,
            itemsProcessed: 0,
            itemsCreated: 0,
            sellerLinked: 0,
            ordersCostComputed: 0
        };

        for (const file of req.files) {

            const rows = await readCsv(file.path);
            const type = detectFileType(rows);

            /* ===== ORDER FILE ===== */
            if (type === "orders") {
                const affectedOrders = new Set();
                const orderShippingByOrderId = new Map();
                const bulkOps = rows
                    .map(row => {
                        if (!row["Order ID"]) return null;
                        affectedOrders.add(row["Order ID"]);
                        orderShippingByOrderId.set(row["Order ID"], {
                            address1: row["Street 1"],
                            address2: row["Street 2"],
                            city: row["Ship City"],
                            state: row["Ship State"],
                            zipcode: row["Ship Zipcode"],
                            country: row["Ship Country"],
                        });

                        const orderValue = toNumber(row["Order Value"]) || 0;
                        const shipping = toNumber(row["Shipping"]) || 0;
                        const orderTotal = toNumber(row["Order Total"]) || 0;
                        const discountAmount = toNumber(row["Discount Amount"]) || 0;
                        const cardProcessingFees = toNumber(row["Card Processing Fees"]) || 0;
                        const orderNet = toNumber(row["Order Net"]) || 0;

                        let salesTax = toNumber(row["Sales Tax"]) || 0;

                        // Recalculate Sales Tax if 0 (Etsy Marketplace Facilitator Tax scenario)
                        // Formula: Order Total = Order Value + Shipping + Sales Tax - Discount Amount
                        if (salesTax === 0 && orderTotal > 0) {
                            const computedTax = orderTotal - (orderValue + shipping - discountAmount);
                            if (computedTax > 0) {
                                salesTax = Number(computedTax.toFixed(2));
                            }
                        }

                        // Tính FEE theo công thức đặc thù VN:
                        // 1. 6.5% of ordertotal (excluding tax)
                        // 2. 4.5% of ordertotal + 11500vnd (quy đổi USD)
                        // 3. 1.24% of ordertotal (excluding tax)
                        const orderTotalExcludingTax = orderTotal - salesTax;
                        const exchangeRate = 26000; // Tỷ giá giả định 26,000 VND = 1 USD
                        const fixedFeeUsd = 11500 / exchangeRate;

                        const calculatedFee =
                            (0.065 * orderTotalExcludingTax) +
                            (0.045 * orderTotal + fixedFeeUsd) +
                            (0.0124 * orderTotalExcludingTax);

                        return {
                            updateOne: {
                                filter: { orderId: row["Order ID"], shopId },
                                update: {
                                    $setOnInsert: { orderId: row["Order ID"], shopId, items: [] },
                                    $set: {
                                        saleDate: toDate(row["Sale Date"]),
                                        shippedAt: toDate(row["Date Shipped"]),
                                        currency: row["Currency"],
                                        paymentMethod: row["Payment Method"],

                                        "buyer.userId": row["Buyer User ID"],
                                        "buyer.fullName": row["Full Name"],

                                        "shipping.address1": row["Street 1"],
                                        "shipping.address2": row["Street 2"],
                                        "shipping.city": row["Ship City"],
                                        "shipping.state": row["Ship State"],
                                        "shipping.zipcode": row["Ship Zipcode"],
                                        "shipping.country": row["Ship Country"],

                                        "totals.orderValue": orderValue,
                                        "totals.shipping": shipping,
                                        "totals.salesTax": salesTax,
                                        "totals.orderTotal": orderTotal,
                                        "totals.fee": Number(calculatedFee.toFixed(2)),
                                        "totals.cardProcessingFees": cardProcessingFees,
                                        "totals.orderNet": orderNet,
                                        "totals.discountAmount": discountAmount
                                    }
                                },
                                upsert: true
                            }
                        };
                    })
                    .filter(Boolean);

                const shippingChangedOrderIds = new Set();
                if (affectedOrders.size > 0) {
                    const existingOrders = await EtsyOrder.find({ orderId: { $in: [...affectedOrders] }, shopId })
                        .select({ orderId: 1, shipping: 1 })
                        .lean();
                    const existingByOrderId = new Map(existingOrders.map((order) => [String(order.orderId), order]));
                    for (const oid of affectedOrders) {
                        const existing = existingByOrderId.get(String(oid));
                        const incomingShipping = orderShippingByOrderId.get(String(oid)) || {};
                        if (!existing || hasEtsyShippingAddressChanged(existing.shipping || {}, incomingShipping)) {
                            shippingChangedOrderIds.add(String(oid));
                        }
                    }
                }

                if (bulkOps.length) {
                    await EtsyOrder.bulkWrite(bulkOps, { ordered: false });
                }

                for (const oid of affectedOrders) {
                    const order = await EtsyOrder.findOne({ orderId: oid, shopId });
                    await validateAddressIfNeeded(order, { force: shippingChangedOrderIds.has(String(oid)) });
                    await logOrderLifecycleEvent({
                        platform: "etsy",
                        orderId: String(oid),
                        orderObjectId: order?._id || null,
                        shopId,
                        stage: "IMPORT",
                        eventType: "ORDER_FILE_IMPORTED",
                        status: "success",
                        actorType: "user",
                        actorId: req.user?._id,
                        actorName: req.user?.name || req.user?.email || "",
                        metadata: { fileType: "orders" },
                    });
                    try {
                        if (order && Array.isArray(order.items) && order.items.length > 0) {
                            await calculateEtsyCost(order);
                            stats.ordersCostComputed += 1;
                            await logOrderLifecycleEvent({
                                platform: "etsy",
                                orderId: String(oid),
                                orderObjectId: order._id,
                                shopId,
                                stage: "AUTO_COST",
                                eventType: "AUTO_COST_SUCCESS",
                                status: "success",
                                actorType: "system",
                                message: "Auto cost computed after Etsy order file import",
                                metadata: { base_cost: order.base_cost, fileType: "orders" },
                            });
                        }
                    } catch (err) {
                        logger.error(`Auto-compute cost failed for Etsy order ${oid}: ${err.message}`);
                        await logOrderLifecycleEvent({
                            platform: "etsy",
                            orderId: String(oid),
                            orderObjectId: order?._id || null,
                            shopId,
                            stage: "AUTO_COST",
                            eventType: "AUTO_COST_FAILED",
                            status: "failed",
                            actorType: "system",
                            reason: err.message,
                            metadata: { fileType: "orders" },
                        });
                    }
                }
            }

            /* ===== ITEM FILE ===== */
            if (type === "items") {

                const affectedOrders = new Set();
                // 🔥 Batch lookup: lấy tất cả SKU → tìm IMAGE1 từ etsylistings
                const allSkus = rows
                    .map(r => r["SKU"])
                    .filter(Boolean);
                const uniqueSkus = [...new Set(allSkus)];
                const listings = await EtsyListing.find({ SKU: { $in: uniqueSkus } }).lean();
                const skuImageMap = new Map();
                for (const listing of listings) {
                    if (listing.SKU && listing.IMAGE1) {
                        skuImageMap.set(listing.SKU, listing.IMAGE1);
                    }
                }

                for (const row of rows) {

                    const orderId = row["Order ID"];
                    if (!orderId) continue;

                    affectedOrders.add(orderId);

                    await EtsyOrder.updateOne(
                        { orderId, shopId },
                        { $setOnInsert: { orderId, shopId, items: [] } },
                        { upsert: true }
                    );

                    const itemSku = row["SKU"];
                    const baseImageUrl = skuImageMap.get(itemSku) || null;

                    const itemDoc = {
                        transactionId: row["Transaction ID"],
                        listingId: row["Listing ID"],
                        sku: itemSku,
                        itemName: row["Item Name"],
                        quantity: toInt(row["Quantity"]) ?? 1,
                        unitPrice: toNumber(row["Price"]),
                        itemTotal: toNumber(row["Item Total"]),
                        variationsRaw: row["Variations"],
                        variations: parseVariations(row["Variations"]),
                        baseImage: baseImageUrl ? { imageUrl: baseImageUrl } : undefined,
                        customizations: { textFields: [], buyerNote: "", raw: null },
                        customFiles: [],
                    };

                    const updateExisting = await EtsyOrder.updateOne(
                        { orderId, shopId, "items.transactionId": itemDoc.transactionId },
                        {
                            $set: {
                                "items.$.transactionId": itemDoc.transactionId,
                                "items.$.listingId": itemDoc.listingId,
                                "items.$.sku": itemDoc.sku,
                                "items.$.itemName": itemDoc.itemName,
                                "items.$.quantity": itemDoc.quantity,
                                "items.$.unitPrice": itemDoc.unitPrice,
                                "items.$.itemTotal": itemDoc.itemTotal,
                                "items.$.variationsRaw": itemDoc.variationsRaw,
                                "items.$.variations": itemDoc.variations,
                                "items.$.baseImage": itemDoc.baseImage,
                            },
                        }
                    );

                    if (updateExisting.matchedCount === 0) {
                        await EtsyOrder.updateOne(
                            { orderId, shopId },
                            { $push: { items: itemDoc } }
                        );
                    } else {
                        logger.debug({
                            tag: "ETSY_CUSTOM_DATA_CSV_IMPORT_PRESERVE_CUSTOM",
                            orderId,
                            transactionId: itemDoc.transactionId,
                        });
                    }

                    // 🔥 GIỮ NGUYÊN SELLER FLOW
                    const sellerCode = getSellerCodeFromSku(itemDoc.sku);
                    if (sellerCode) {
                        await fillSellerIfMissing(orderId, shopId, sellerCode);
                        stats.sellerLinked += 1;
                    }

                    stats.itemsProcessed += 1;
                }

                for (const oid of affectedOrders) {
                    await EtsyOrder.updateOne(
                        { orderId: oid, shopId },
                        [{ $set: { numberOfItems: { $size: { $ifNull: ["$items", []] } } } }]
                    );

                    const order = await EtsyOrder.findOne({ orderId: oid, shopId });
                    await validateAddressIfNeeded(order);
                    await logOrderLifecycleEvent({
                        platform: "etsy",
                        orderId: String(oid),
                        orderObjectId: order?._id || null,
                        shopId,
                        stage: "IMPORT",
                        eventType: "ORDER_FILE_IMPORTED",
                        status: "success",
                        actorType: "user",
                        actorId: req.user?._id,
                        actorName: req.user?.name || req.user?.email || "",
                        metadata: { fileType: "items" },
                    });

                    try {
                        // Tự động tính toán cost breakdown sau khi import
                        if (order && Array.isArray(order.items) && order.items.length > 0) {
                            await calculateEtsyCost(order);
                            stats.ordersCostComputed += 1;
                            await logOrderLifecycleEvent({
                                platform: "etsy",
                                orderId: String(oid),
                                orderObjectId: order._id,
                                shopId,
                                stage: "AUTO_COST",
                                eventType: "AUTO_COST_SUCCESS",
                                status: "success",
                                actorType: "system",
                                message: "Auto cost computed after Etsy item file import",
                                metadata: { base_cost: order.base_cost, fileType: "items" },
                            });
                        }
                    } catch (err) {
                        logger.error(`Auto-compute cost failed for Etsy order ${oid}: ${err.message}`);
                        await logOrderLifecycleEvent({
                            platform: "etsy",
                            orderId: String(oid),
                            orderObjectId: order?._id || null,
                            shopId,
                            stage: "AUTO_COST",
                            eventType: "AUTO_COST_FAILED",
                            status: "failed",
                            actorType: "system",
                            reason: err.message,
                            metadata: { fileType: "items" },
                        });
                    }
                }

            }

            fs.unlink(file.path, () => { });
        }

        stats.missingBaseCostBackfill = await computeMissingEtsyBaseCosts({
            limit: req.body?.missingBaseCostLimit,
        });

        return res.json({
            message: "Etsy Order import completed (multi-shop + seller preserved)",
            stats
        });

    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message });
    }
};

/* =======================================================
   GET LIST
======================================================= */

const getListOrders = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            from,
            to,
            search,
            platform,
            userNull,
            noPsd,
            shippingType,
            shopName,
            teamId,
            vendorId,
            vendor,
            openCase,
            status,
            isNoCostCenter,
            invalidAddress,
            includeLogs,
            logLimit,
            sortBy = "saleDate",
            sortOrder = "desc",
        } = req.query;

        const filter = await buildEtsyOrderFilter(req.query);

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(200, parseInt(limit));
        const skip = (pageNum - 1) * limitNum;

        // ===== Sort =====
        const allowedSortFields = ["saleDate", "createdAt", "updatedAt", "base_cost", "numberOfItems", "orderId", "status"];
        const sortField = allowedSortFields.includes(sortBy) ? sortBy : "saleDate";
        const sortDir = sortOrder === "asc" ? 1 : -1;

        const [total, rawData] = await Promise.all([
            EtsyOrder.countDocuments(filter),
            EtsyOrder.find(filter)
                .select(ETSY_LIST_SELECT_FIELDS)
                .populate("shopId", "name store merchant")
                .populate("seller.sellerId", "full_name email employee_id")
                .populate("items.seller.sellerId", "full_name email employee_id")
                .populate("case", "name description blocksProduction")
                .sort({ [sortField]: sortDir })
                .skip(skip)
                .limit(limitNum)
                .lean(),
        ]);

        const historyByOrder = new Map();
        if (String(includeLogs).toLowerCase() === "true" && rawData.length) {
            const limitLogs = Math.max(1, Math.min(parseInt(logLimit, 10) || 5, 50));
            const logs = await OrderHistory.find({ order: { $in: rawData.map((order) => order._id) } })
                .sort({ createdAt: -1 })
                .select("order action description changes orderItemId userId userName userRole source createdAt")
                .lean();

            for (const log of logs) {
                const key = String(log.order);
                const events = historyByOrder.get(key) || [];
                if (events.length < limitLogs) events.push(log);
                historyByOrder.set(key, events);
            }
        }

        // ===== Collect vendorProductIds for cost_center =====
        const vpIdSet = new Set();
        for (const order of rawData) {
            for (const item of (order.items || [])) {
                if (item.cost_breakdown?.vendorProductId) {
                    vpIdSet.add(item.cost_breakdown.vendorProductId);
                }
            }
        }

        // Batch lookup VendorProduct + Vendor
        const vpMap = new Map(); // vendorProductId -> { vendorProductDisplayName, ... }
        if (vpIdSet.size > 0) {
            const VendorProduct = db.vendorProduct;
            const Vendor = db.vendor;
            const vpDocs = await VendorProduct.find({ _id: { $in: [...vpIdSet] } }).lean();
            const vendorIds = [...new Set(vpDocs.map(vp => String(vp.vendor_id)))];
            const vendorDocs = await Vendor.find({ _id: { $in: vendorIds } }).lean();
            const vendorMap = new Map(vendorDocs.map(v => [String(v._id), v.name]));

            for (const vp of vpDocs) {
                const vendorName = vendorMap.get(String(vp.vendor_id)) || "Unknown";
                vpMap.set(String(vp._id), {
                    vendorProductId: String(vp._id),
                    vendorProductDisplayName: `${vendorName} - ${vp.product_name || ""}`,
                });
            }
        }

        // ===== Transform data =====
        const data = rawData.map((order) => {
            const shop = order.shopId || {};
            const sellerPopulated = order.seller?.sellerId || null;

            return {
                orderId: order.orderId,
                customer_infor: {
                    name: order.buyer?.fullName || order.shipping?.name || "",
                    address: order.shipping?.address1 || "",
                    address_2: order.shipping?.address2 || "",
                    city: order.shipping?.city || "",
                    state: order.shipping?.state || "",
                    zip_code: order.shipping?.zipcode || "",
                    country: order.shipping?.country || "",
                },
                status: order.status || "New",
                purchase_date: order.saleDate || null,
                createdAt: order.createdAt || null,
                shopId: shop._id ? String(shop._id) : String(order.shopId || ""),
                shopName: shop.name || shop.store || "",
                shipping_type: order.shipping_type || "Standard",
                manual_vendor_required: order.manual_vendor_required === true,
                case: order.case || [],
                items: (order.items || []).map((item) => {
                    const itemSellerPopulated = item.seller?.sellerId || null;
                    // Build cost_center
                    let cost_center = null;
                    if (item.cost_breakdown?.vendorProductId) {
                        const vpInfo = vpMap.get(String(item.cost_breakdown.vendorProductId));
                        cost_center = {
                            vendorProductId: item.cost_breakdown.vendorProductId,
                            vendorProductDisplayName: vpInfo?.vendorProductDisplayName || "",
                            sizeValue: item.cost_breakdown.sizeValue || null,
                            colorValue: item.cost_breakdown.colorValue || null,
                        };
                    }

                    // Build version3Data from variations
                    let version3Data = null;
                    if (item.variations && typeof item.variations === "object") {
                        version3Data = Object.entries(item.variations).map(([label, value]) => ({
                            label,
                            value: value || "",
                        }));
                    }

                    return {
                        orderItemId: item.transactionId || "",
                        sku: item.sku || "",
                        mapped_sku: item.mapped_sku || null,
                        seller: itemSellerPopulated ? {
                            _id: itemSellerPopulated._id || itemSellerPopulated,
                            full_name: itemSellerPopulated.full_name || "",
                            email: itemSellerPopulated.email || "",
                            sellerCode: item.seller?.sellerCode || "",
                        } : (item.seller?.sellerCode ? { sellerCode: item.seller.sellerCode } : null),
                        title: item.itemName || "",
                        quantity: item.quantity || 1,
                        version3Data,
                        baseImageUrl: item.baseImage?.imageUrl || "",
                        listingId: item.listingId || null,
                        cost_center,
                        tracking_info: buildEtsyTrackingInfoResponse(order, item),
                        tracking_summary: buildEtsyTrackingSummary(order, item),
                        fulfillment_file: toPlainFulfillmentFile(item.fulfillment_file),
                        scale_status: item.scale_status || null,
                        ...buildCustomItemResponseFields(item),
                        qc_note: item.qc_note || "",
                        cs_note: item.cs_note || "",
                    };
                }),
                base_cost: order.base_cost || 0,
                tracking_summary: buildEtsyTrackingSummary(order, (order.items || [])[0] || {}),
                sumbittedoetsy: order.sumbittedoetsy ?? false,
                address_validation: order.address_validation?.isValid ?? null,
                address_validation_status: order.address_validation?.status || null,
                address_validation_detail: order.address_validation || null,
                seller: sellerPopulated ? {
                    _id: sellerPopulated._id,
                    full_name: sellerPopulated.full_name,
                    email: sellerPopulated.email,
                } : null,
                numberOfItems: order.numberOfItems || 0,
                history: [...(historyByOrder.get(String(order._id)) || [])].reverse(),
            };
        });

        return res.json({
            data,
            totalCount: total,
            totalPages: Math.ceil(total / limitNum),
            currentPage: pageNum,
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message });
    }
};

/* ================== COMPUTE BASE COST LOGIC ================== */

const ConfigCostCenter = db.configCostCenter;
const VendorCostCenter = db.vendorCostCenter;
const ConfigOptionMapping = db.configOptionMapping;
const VendorProduct = db.vendorProduct;

function parseConfigCodeFromSKU(sku = "") {
    const parts = String(sku).split("-").map((s) => s.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[1] : "";
}

function normalize(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toArray(val) {
    if (Array.isArray(val)) return val;
    if (val == null) return [];
    return [val];
}

function pickValueByKeys(labelValueMap, keys = []) {
    for (const k of toArray(keys)) {
        const v = labelValueMap.get(normalize(k));
        if (v != null && v !== "") return v;
    }
    return "";
}

function extractLabelValueMapFromEtsyItem(item) {
    const map = new Map();
    const vars = item?.variations || {};
    for (const [label, value] of Object.entries(vars)) {
        if (!label) continue;
        const normLabel = normalize(label);
        map.set(normLabel, String(value || ""));
        if (normLabel === "style - size" && value) {
            const lastDash = String(value).lastIndexOf(" - ");
            if (lastDash > 0) {
                const stylePart = String(value).substring(0, lastDash).trim();
                const sizePart = String(value).substring(lastDash + 3).trim();
                if (!map.has("style")) map.set("style", stylePart);
                if (!map.has("size")) map.set("size", sizePart);
                if (!map.has("product type")) map.set("product type", stylePart);
            }
        }
    }
    return map;
}

async function selectConfigByProductType(configCode, labelValueMap, mapOptionValue = null) {
    let cfgCandidates = await ConfigCostCenter.find({
        config_code: configCode,
        platform: "Etsy",
        is_deleted: { $in: [false, null] },
    })
        .populate("product_for_seller")
        .lean();

    if (!cfgCandidates.length) {
        cfgCandidates = await ConfigCostCenter.find({
            config_code: configCode,
            is_deleted: { $in: [false, null] },
        })
            .populate("product_for_seller")
            .lean();
    }

    if (!cfgCandidates.length)
        return { cfg: null, reason: "No config cost center found by config_code" };

    let mappedProductTypeInfo = null;

    for (const c of cfgCandidates) {
        let typeValRaw = pickValueByKeys(labelValueMap, c.customize_product_type_key || []);

        // Etsy fallback: nếu không tìm thấy key "Select Product Type", thử lấy "product type" 
        if (!typeValRaw && labelValueMap.has("product type")) {
            typeValRaw = labelValueMap.get("product type");
        }

        let typeValToMatch = normalize(typeValRaw);

        // Thử mapping biến thể kiểu product type nếu có mapOptionValue
        if (typeValRaw && mapOptionValue && !mappedProductTypeInfo) {
            mappedProductTypeInfo = await mapOptionValue({ configCode, key: "product type", rawValue: typeValRaw });
        }

        if (mappedProductTypeInfo && mappedProductTypeInfo.value && normalize(mappedProductTypeInfo.value) !== typeValToMatch) {
            typeValToMatch = normalize(mappedProductTypeInfo.value);
        }

        const sellerName = normalize(c?.product_for_seller?.name || "");
        if (typeValToMatch && sellerName && typeValToMatch === sellerName) {
            return { cfg: c, productTypeValue: typeValRaw, matchedBy: mappedProductTypeInfo?.matchType ? "product_type_mapped" : "product_type_exact" };
        }
    }

    if (cfgCandidates.length === 1) {
        const only = cfgCandidates[0];
        const typeValRaw = pickValueByKeys(labelValueMap, only.customize_product_type_key || []);
        return { cfg: only, productTypeValue: typeValRaw, matchedBy: "single_candidate_fallback" };
    }

    // Fallback: partial match
    const partialMatches = [];
    for (const c of cfgCandidates) {
        const typeValRaw = pickValueByKeys(labelValueMap, c.customize_product_type_key || []);
        const typeVal = normalize(typeValRaw);
        const sellerName = normalize(c?.product_for_seller?.name || "");
        if (typeVal && sellerName && sellerName.includes(typeVal)) {
            partialMatches.push({ cfg: c, typeValRaw });
        }
    }

    if (partialMatches.length === 1) {
        return {
            cfg: partialMatches[0].cfg,
            productTypeValue: partialMatches[0].typeValRaw,
            matchedBy: "product_type_partial_match",
        };
    }

    return { cfg: null, reason: `Multiple configs (${cfgCandidates.length}) - partial matches (${partialMatches.length}); cannot determine by product type key/value` };
}

function normalizeEtsyCostValue(value) {
    return decodeEtsyHtmlEntities(value)
        .trim()
        .toLowerCase()
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/′′/g, '"')
        .replace(/″/g, '"')
        .replace(/''/g, '"')
        .replace(/\s+/g, " ");
}

function formatEtsyCostValueForDisplay(value) {
    return decodeEtsyHtmlEntities(value)
        .trim()
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/′′/g, '"')
        .replace(/″/g, '"')
        .replace(/''/g, '"')
        .replace(/\s+/g, " ");
}

function findBestCostCenter(candidates, sizeValue, colorValue, { strict = true } = {}) {
    const hit = candidates.find((c) =>
        normalizeEtsyCostValue(c.vendor_size) === normalizeEtsyCostValue(sizeValue) &&
        normalizeEtsyCostValue(c.vendor_color) === normalizeEtsyCostValue(colorValue)
    );

    if (hit) return hit;
    if (strict) return null;
    return null;
}

async function getVendorIdByVendorProductId(vpId) {
    const vp = await VendorProduct.findById(vpId).select("vendor_id").lean();
    return vp?.vendor_id ? String(vp.vendor_id) : null;
}

function choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) {
    if (!candidateSetsPerItem.length) return null;
    let inter = new Set(candidateSetsPerItem[0]);
    for (let i = 1; i < candidateSetsPerItem.length; i++) {
        inter = new Set([...inter].filter((v) => candidateSetsPerItem[i].has(v)));
        if (inter.size === 0) break;
    }
    if (!inter.size) return null;
    let best = null, bestRank = Infinity;
    for (const vId of inter) {
        const r = vendorRank.get(String(vId)) ?? 999;
        if (r < bestRank || (r === bestRank && String(vId) < String(best))) { best = vId; bestRank = r; }
    }
    return best;
}

async function calculateEtsyCost(order) {
    // ===== QUERY CACHE =====
    const _cfgCache = new Map(), _optCache = new Map(), _vpIdCache = new Map(), _vccCache = new Map();
    const cachedMapOption = async (o) => { const k = `${o.configCode}::${o.key}::${o.rawValue}`; if (_optCache.has(k)) return _optCache.get(k); const r = await mapOptionValue(o); _optCache.set(k, r); return r; };
    const cachedSelectConfig = async (cc, lvm) => { if (_cfgCache.has(cc)) return _cfgCache.get(cc); const r = await selectConfigByProductType(cc, lvm, cachedMapOption); _cfgCache.set(cc, r); return r; };
    const cachedVendorId = async (vpId) => { const k = String(vpId); if (_vpIdCache.has(k)) return _vpIdCache.get(k); const r = await getVendorIdByVendorProductId(vpId); _vpIdCache.set(k, r); return r; };
    const cachedVCC = async (vpId) => { const k = String(vpId); if (_vccCache.has(k)) return _vccCache.get(k); const docs = await VendorCostCenter.find({ vendor_product: vpId, status: { $in: ["Active", "active", null] } }).select("vendor_size vendor_color standard_size standard_color base_cost sku international priority additional_costs printing_method").lean(); _vccCache.set(k, docs); return docs; };

    // ===== helper: sku audit (giống Amazon version) =====
    function getSkuForCost(item) {
        const originalSku = (item?.sku || "").trim() || null;
        const mappedSku = (item?.mapped_sku || "").trim() || null;
        const usedSku = mappedSku || originalSku; // ưu tiên mapped_sku
        return { originalSku, mappedSku, usedSku };
    }

    // ===== PASS 1: Pre-scan =====
    const stagedItems = [], preItems = [], candidateSetsPerItem = [];

    for (const item of order.items) {
        const itemId = item.transactionId;
        const { originalSku, mappedSku, usedSku } = getSkuForCost(item);

        const configCode = parseConfigCodeFromSKU(usedSku);
        if (!configCode) { stagedItems.push({ transactionId: itemId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, status: "failed", reason: "Cannot parse config code" }); continue; }

        if (item.manual_vendor_cost_center_id) {
            const vcc = await VendorCostCenter.findById(item.manual_vendor_cost_center_id).lean();
            if (vcc && Number(vcc.base_cost || 0) > 0) {
                const vId = await cachedVendorId(vcc.vendor_product);
                preItems.push({
                    item,
                    itemId,
                    sku: originalSku,
                    mapped_sku: mappedSku,
                    used_sku: usedSku,
                    configCode,
                    productTypeValue: null,
                    matchedBy: "manual",
                    sizeValue: vcc.vendor_size,
                    colorValue: vcc.vendor_color,
                    manualVcc: vcc,
                    vendorId: vId,
                });
                candidateSetsPerItem.push(new Set(vId ? [vId] : []));
                continue;
            }
            logger.warn(`[calculateEtsyCost] Manual VCC ${item.manual_vendor_cost_center_id} not found or has 0 cost. Falling back to auto.`);
        }

        if (order.manual_vendor_required === true) {
            stagedItems.push({ transactionId: itemId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, configCode, status: "failed", reason: "Manual vendor selection required" });
            continue;
        }

        const labelValueMap = extractLabelValueMapFromEtsyItem(item);
        const { cfg, productTypeValue, matchedBy, reason: cfgReason } = await cachedSelectConfig(configCode, labelValueMap);

        if (!cfg) { stagedItems.push({ transactionId: itemId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, configCode, status: "failed", reason: cfgReason }); continue; }

        const sizeRaw = pickValueByKeys(labelValueMap, cfg.customize_size_key || []);
        const colorRaw = pickValueByKeys(labelValueMap, cfg.customize_color_key || []) || cfg.default_color || "";
        // mapOptionValue: convert size/color raw → vendor-compatible value
        const sizeMap = await cachedMapOption({ configCode, key: "size", rawValue: sizeRaw });
        const colorMap = await cachedMapOption({ configCode, key: "color", rawValue: colorRaw });

        let pfItems = toArray(cfg?.product_for_seller?.items).filter(Boolean);
        if (!pfItems.length) { stagedItems.push({ transactionId: itemId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, configCode, status: "failed", reason: "No pfItems" }); continue; }

        if (["EBM", "EBMA"].includes(configCode.toUpperCase())) {
            const activeItems = pfItems.filter((x) => (x?.status || "").toLowerCase() === "active");
            const fifth = activeItems.find((x) => Number(x.order) === 5);
            if (fifth) pfItems = [fifth];
            else { const sorted = [...activeItems].sort((a, b) => Number(a.order) - Number(b.order)); pfItems = sorted.length >= 5 ? [sorted[4]] : pfItems; }
        }

        preItems.push({ item, itemId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, configCode, productTypeValue, matchedBy, sizeValue: sizeMap.value, colorValue: colorMap.value, pfItems });

        const vendorSet = new Set();
        for (const pf of pfItems) {
            const vpId = pf?.vendor_product; if (!vpId) continue;
            const candidates = await cachedVCC(vpId);
            const hit = findBestCostCenter(candidates, sizeMap.value, colorMap.value, { strict: true });
            if (!hit) continue;
            const vId = String(pf?.vendor_id || pf?.vendor?._id || (await cachedVendorId(vpId)) || "");
            if (vId) vendorSet.add(vId);
        }
        candidateSetsPerItem.push(vendorSet);
    }

    let preferredVendorId = order.forced_vendor_id ? String(order.forced_vendor_id) : null;
    if (preItems.length >= 2) {
        const vendorRank = new Map();
        for (const pre of preItems) {
            if (pre.manualVcc) continue;
            for (const it of toArray(pre.pfItems)) { const vpId = it?.vendor_product; if (!vpId) continue; const vId = String(it?.vendor_id || it?.vendor?._id || (await cachedVendorId(vpId)) || ""); if (!vId) continue; vendorRank.set(vId, Math.min(vendorRank.get(vId) ?? 999, it.order ?? 999)); }
        }
        if (!preferredVendorId) {
            preferredVendorId = choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) || null;
        }
    }

    // ===== PASS 2: Detailed calculation =====
    const groups = new Map();
    for (const pre of preItems) {
        const { item, itemId, sku, mapped_sku, used_sku, configCode, productTypeValue, matchedBy, sizeValue, colorValue } = pre;
        const { pfItems } = pre;

        const vendorSelection = await (async () => {
            if (pre.manualVcc) {
                return {
                    success: true,
                    vendorProductId: pre.manualVcc.vendor_product,
                    matched: pre.manualVcc,
                    selectedOrder: -1,
                    itemDisplayName: "Manual Selection",
                    vendorId: pre.vendorId,
                };
            }

            const byOrder = (a, b) => (a.order || 999) - (b.order || 999);
            const actives = pfItems.filter((it) => String(it.status || "").toLowerCase() === "active").sort(byOrder);
            let itemsToCheck = actives.length ? actives : [...pfItems].sort(byOrder);
            const resolved = [];
            for (const it of itemsToCheck) { const vpId = it?.vendor_product; if (!vpId) continue; const vId = String(it?.vendor_id || it?.vendor?._id || (await cachedVendorId(vpId)) || ""); resolved.push({ ...it, __vendorId: vId, __vendorProductId: vpId }); }
            const filtered = preferredVendorId ? resolved.filter((x) => x.__vendorId && String(x.__vendorId) === String(preferredVendorId)) : resolved;
            if (preferredVendorId && filtered.length === 0) return { success: false, reason: `No pfItems under vendor ${preferredVendorId}` };
            const checkList = filtered.length ? filtered : resolved;
            for (const cItem of checkList) {
                const candidates = await cachedVCC(cItem.__vendorProductId); if (!candidates?.length) continue;
                let hit = findBestCostCenter(candidates, sizeValue, colorValue, { strict: true });
                if (!hit) hit = findBestCostCenter(candidates, sizeValue, colorValue, { strict: false });
                if (hit && Number(hit?.base_cost || 0) > 0) return { success: true, vendorProductId: cItem.__vendorProductId, matched: hit, selectedOrder: cItem.order || 999, itemDisplayName: cItem.display_name || "Unknown", vendorId: cItem.__vendorId };
            }
            return { success: false, reason: "No matching vendor product" };
        })();

        if (!vendorSelection.success) { stagedItems.push({ transactionId: itemId, sku, mapped_sku, used_sku, configCode, sizeValue, colorValue, status: "failed", reason: vendorSelection.reason }); continue; }

        const { vendorProductId, matched, selectedOrder, itemDisplayName, vendorId } = vendorSelection;
        const baseEach = Number(matched?.base_cost || 0) + 1; // +1$ per item surcharge
        const qty = Math.max(1, Number(item.quantity || 1));

        const rate = await (async () => {
            const pickFromDoc = (doc, pp) => { if (!doc) return null; const hp = doc.priority && (doc.priority.economy != null || doc.priority.additional != null); const hi = doc.international && (doc.international.economy != null || doc.international.additional != null); if (pp === "priority" && hp) return { eco: Number(doc.priority.economy ?? 0), add: Number(doc.priority.additional ?? 0), profile: "priority" }; if (hi) return { eco: Number(doc.international.economy ?? 0), add: Number(doc.international.additional ?? 0), profile: "international" }; return null; };
            if (matched?.international && (matched.international.economy != null || matched.international.additional != null))
                return { eco: Number(matched.international.economy ?? 0), add: Number(matched.international.additional ?? 0), profile: "international" };
            const allDocs = await cachedVCC(vendorProductId);
            for (const doc of allDocs) { const p = pickFromDoc(doc, "international"); if (p) return p; }
            return { eco: 0, add: 0, profile: "international" };
        })();

        const additionalCosts = { embroidery: 0, two_sided_print: 0, two_position_print: 0 };
        if (["TSB"].includes(configCode.toUpperCase())) additionalCosts.two_sided_print = Number(matched?.additional_costs?.two_sided_print || 0);
        if (["TS2S"].includes(configCode.toUpperCase())) additionalCosts.two_position_print = Number(matched?.additional_costs?.two_position_print || 0);
        if (["EBM", "EBMA"].includes(configCode.toUpperCase())) additionalCosts.embroidery = Number(matched?.additional_costs?.embroidery || 0);
        const totalAdditionalCost = additionalCosts.embroidery + additionalCosts.two_sided_print + additionalCosts.two_position_print;

        const rec = { transactionId: itemId, sku, mapped_sku, used_sku, configCode, productTypeValue: productTypeValue || null, selectedConfigBy: matchedBy || "unknown", sizeValue, colorValue, vendorProductId, vendorId, selectedOrder, itemDisplayName, baseEach, qty, eco: rate.eco, add: rate.add, shipProfile: rate.profile, matchedSku: matched?.sku || null, printing_method: matched?.printing_method || "", additionalCosts, totalAdditionalCost, status: "ok" };
        stagedItems.push(rec);
        const key = `${vendorId}::profile=${rate.profile}::eco=${rate.eco}::add=${rate.add}`;
        const g = groups.get(key) || { vendorId, shipProfile: rate.profile, items: [], economyMax: 0 };
        g.items.push({ ...rec }); g.economyMax = Math.max(g.economyMax, rate.eco); groups.set(key, g);
    }

    // ===== Tổng hợp =====
    const perItemResults = [];
    const groupBreakdowns = [];
    for (const rec of stagedItems) {
        const displaySizeValue = formatEtsyCostValueForDisplay(rec.sizeValue);
        const displayColorValue = formatEtsyCostValueForDisplay(rec.colorValue);
        if (rec.status !== "ok") {
            perItemResults.push({
                ...rec,
                sizeValue: displaySizeValue,
                colorValue: displayColorValue,
            });
            continue;
        }
        perItemResults.push({
            transactionId: rec.transactionId, sku: rec.sku, configCode: rec.configCode, sizeValue: displaySizeValue, colorValue: displayColorValue, productTypeValue: rec.productTypeValue, selectedConfigBy: rec.selectedConfigBy,
            vendorProductId: rec.vendorProductId, vendorId: rec.vendorId, matchedSku: rec.matchedSku, printing_method: rec.printing_method || "", selectedOrder: rec.selectedOrder, itemDisplayName: rec.itemDisplayName,
            base_cost_each: rec.baseEach, quantity: rec.qty,
            additional_costs_breakdown: rec.additionalCosts, total_additional_cost_per_item: rec.totalAdditionalCost * rec.qty,
            shipping_international_economy: 0, shipping_international_additional_units: 0, shipping_international_additional_rate: 0,
            base_cost_total_for_item_including_shipping: rec.baseEach * rec.qty + rec.totalAdditionalCost * rec.qty,
            status: "ok",
        });
    }

    // Phân bổ shipping
    for (const [, g] of groups.entries()) {
        const totalQtyProfile = g.items.reduce((s, it) => s + it.qty, 0);
        if (totalQtyProfile <= 0) continue;
        const ecoOnce = g.economyMax;
        let remainEco = 1, remainAdd = Math.max(0, totalQtyProfile - 1);
        const sorted = [...g.items].sort((a, b) => b.eco - a.eco);
        for (const it of sorted) {
            const out = perItemResults.find((r) => r.transactionId === it.transactionId && r.status === "ok"); if (!out) continue;
            let ecoHere = 0;
            if (remainEco > 0 && it.qty > 0) { ecoHere = ecoOnce; remainEco = 0; }
            let addUnits = it.qty - (ecoHere > 0 ? 1 : 0);
            addUnits = Math.max(0, Math.min(addUnits, remainAdd)); remainAdd -= addUnits;
            out.shipping_international_economy += ecoHere;
            out.shipping_international_additional_units += addUnits;
            out.shipping_international_additional_rate = it.add;
            out.base_cost_total_for_item_including_shipping = Number((out.base_cost_total_for_item_including_shipping + ecoHere + addUnits * it.add).toFixed(2));
            out.formula = `(base ${it.baseEach} * qty ${it.qty}) + add_cost ${it.totalAdditionalCost} * qty ${it.qty} + [${g.shipProfile}] eco ${ecoHere} + add ${it.add} * ${addUnits}`;
        }
        groupBreakdowns.push({ vendor_id: g.vendorId, total_qty: totalQtyProfile, shipping_profile: g.shipProfile, shipping_economy_once: ecoOnce });
    }

    let total = 0;
    for (const r of perItemResults) if (r.status === "ok") total += r.base_cost_total_for_item_including_shipping;

    // ===== LƯU VÀO DATABASE MONGODB BẰNG BULK WRITE - BỎ QUA GỐC MONGOOSE ARRAY MAPPING LỖI =====
    if (order._id) {
        const itemBulkOps = [];
        for (const out of perItemResults) {
            if (out.status !== "ok") continue;

            itemBulkOps.push({
                updateOne: {
                    filter: { _id: order._id, "items.transactionId": out.transactionId },
                    update: {
                        $set: {
                            "items.$.cost_breakdown": {
                                configCode: out.configCode,
                                productTypeValue: out.productTypeValue || "Unknown",
                                selectedConfigBy: out.selectedConfigBy || "Unknown",
                                sizeValue: out.sizeValue || "",
                                colorValue: out.colorValue || "",
                                vendorProductId: out.vendorProductId || "",
                                matchedSku: out.matchedSku || "",
                                selectedOrder: out.selectedOrder || 1,
                                itemDisplayName: out.itemDisplayName || "",
                                base_cost_each: out.base_cost_each || 0,
                                quantity: out.quantity || 1,
                                additional_costs_breakdown: {
                                    embroidery: out.additional_costs_breakdown?.embroidery || 0,
                                    two_sided_print: out.additional_costs_breakdown?.two_sided_print || 0,
                                    two_position_print: out.additional_costs_breakdown?.two_position_print || 0
                                },
                                total_additional_cost_per_item: out.total_additional_cost_per_item || 0,
                                shipping_international_economy: out.shipping_international_economy || 0,
                                shipping_international_additional_units: out.shipping_international_additional_units || 0,
                                shipping_international_additional_rate: out.shipping_international_additional_rate || 0,
                                base_cost_total_for_item_including_shipping: out.base_cost_total_for_item_including_shipping || 0,
                                formula: out.formula || ""
                            }
                        }
                    }
                }
            });
        }

        if (itemBulkOps.length > 0) {
            logger.debug(`[calculateEtsyCost] BulkWrite: ${itemBulkOps.length} ops for order._id=${order._id}`);
            logger.debug(`[calculateEtsyCost] Sample filter: ${JSON.stringify(itemBulkOps[0].updateOne.filter)}`);
            const bulkResult = await EtsyOrder.bulkWrite(itemBulkOps);
            logger.debug(`[calculateEtsyCost] BulkWrite result: ${JSON.stringify({
                matchedCount: bulkResult.matchedCount,
                modifiedCount: bulkResult.modifiedCount,
                upsertedCount: bulkResult.upsertedCount
            })}`);
        } else {
            logger.debug(`[calculateEtsyCost] NO bulkWrite ops - all items failed calculation`);
        }

        order.base_cost = Number(total.toFixed(2));
        order.base_cost_shipping_groups = groupBreakdowns;
        order.base_cost_computed_at = new Date();

        await EtsyOrder.updateOne(
            { _id: order._id },
            {
                $set: {
                    base_cost: order.base_cost,
                    base_cost_shipping_groups: order.base_cost_shipping_groups,
                    base_cost_computed_at: order.base_cost_computed_at
                }
            }
        );
    }

    return {
        preferredVendorId,
        groupBreakdowns,
        perItemResults,
    };
}

const computeBaseCostForEtsyOrder = async (req, res) => {
    let orderId = "";
    let order = null;
    try {
        ({ orderId } = req.body);
        const { orderData } = req.body;
        const forceAddressValidation = toBooleanStrict(
            req.body?.forceAddressValidation ??
            req.body?.forceSmartyValidation ??
            req.body?.revalidateAddress
        ) === true;
        if (!orderId) return res.status(400).json({ message: "Missing orderId" });

        // Sử dụng document gốc để có thể save() đoạn sau
        order = await EtsyOrder.findOne({ orderId });

        // Nếu không tìm thấy Order nhưng có truyền JSON data -> Tạo order mới
        if (!order) {
            if (!orderData || typeof orderData !== "object") {
                return res.status(404).json({ message: "Etsy order not found in DB. Provide 'orderData' object to auto-import." });
            }

            // Gắn cứng orderId từ data truyền vào để tránh lỗi lệch
            orderData.orderId = orderId;

            // Nếu dữ liệu thiếu shopId thì ta tìm 1 shop đại diện hoặc null (tuỳ schema bắt buộc hay ko)
            if (!orderData.shopId) {
                const Shop = db.shop;
                const defaultShop = await Shop.findOne({ status: "active" }).select("_id").lean();
                if (defaultShop) {
                    orderData.shopId = defaultShop._id;
                }
            }

            // Lưu order mới vào DB
            order = new EtsyOrder(orderData);
            await order.save();
            await validateAddressIfNeeded(order, { force: true });
        }

        if (order && forceAddressValidation) {
            await validateAddressIfNeeded(order, { force: true });
        }

        if (!Array.isArray(order.items) || order.items.length === 0) {
            return res.status(400).json({ message: "Order has no items" });
        }

        // Etsy mặc định Standard shipping nếu ko có
        const shippingTypeForOrder = order.shipping_type || "Standard";

        const calculationData = await calculateEtsyCost(order);
        const failedItems = calculationData.perItemResults.filter((item) => item.status !== "ok");
        const lifecycleStatus =
            failedItems.length > 0 || Number(order.base_cost || 0) <= 0
                ? "failed"
                : "success";
        const firstFailureReason =
            failedItems[0]?.reason ||
            (Number(order.base_cost || 0) <= 0 ? "Computed base cost is 0" : "");

        await logOrderLifecycleEvent(buildOrderLifecyclePayload({
            order,
            req,
            fallbackPlatform: "etsy",
            stage: "AUTO_COST",
            eventType: lifecycleStatus === "success"
                ? "AUTO_COST_RETEST_SUCCESS"
                : "AUTO_COST_RETEST_FAILED",
            status: lifecycleStatus,
            message: "Etsy order base cost re-tested",
            reason: firstFailureReason,
            metadata: {
                newBaseCost: order.base_cost,
                itemCount: Array.isArray(order.items) ? order.items.length : 0,
                failedItemCount: failedItems.length,
                shippingGroupCount: calculationData.groupBreakdowns.length,
                failedItems: failedItems.slice(0, 10).map((item) => ({
                    transactionId: item.transactionId,
                    sku: item.used_sku || item.sku || "",
                    configCode: item.configCode || "",
                    reason: item.reason || "",
                })),
            },
        }));

        return res.json({
            platform: "etsy",
            orderId,
            base_cost: order.base_cost,
            preferred_vendor_id: calculationData.preferredVendorId || null,
            shipping_group_breakdowns: calculationData.groupBreakdowns,
            detail: calculationData.perItemResults,
            address_validation: order.address_validation?.isValid ?? null,
            address_validation_status: order.address_validation?.status || null,
            address_validation_detail: order.address_validation || null,
        });

    } catch (err) {
        await logOrderLifecycleEvent(buildOrderLifecyclePayload({
            order: order || { orderId, platform: "etsy" },
            req,
            fallbackPlatform: "etsy",
            stage: "AUTO_COST",
            eventType: "AUTO_COST_RETEST_FAILED",
            status: "failed",
            message: "Etsy order base cost re-test failed",
            reason: err.message,
            metadata: {
                itemCount: Array.isArray(order?.items) ? order.items.length : 0,
            },
        }));
        return res.status(500).json({ message: "Compute failed for Etsy Order", error: err.message });
    }
}

async function computeMissingEtsyBaseCosts({ limit = 50, computeOne = calculateEtsyCost } = {}) {
    const limitNum = Math.min(200, Math.max(1, Number(limit) || 50));
    const orders = await EtsyOrder.find({
        $or: [{ base_cost: { $exists: false } }, { base_cost: null }, { base_cost: 0 }],
        status: { $nin: ["Cancelled", "Canceled"] },
        items: { $exists: true, $ne: [] },
    })
        .sort({ createdAt: -1 })
        .limit(limitNum);

    const result = { attempted: orders.length, computed: 0, failed: 0, errors: [] };
    for (const order of orders) {
        try {
            await computeOne(order);
            result.computed += 1;
        } catch (err) {
            result.failed += 1;
            result.errors.push({ orderId: order.orderId || null, error: err.message });
        }
    }
    return result;
}

const computeMissingBaseCostsForEtsyOrders = async (req, res) => {
    try {
        const result = await computeMissingEtsyBaseCosts({ limit: req.body?.limit });
        return res.json({
            message: "Etsy missing base cost batch computed",
            ...result,
        });
    } catch (err) {
        return res.status(500).json({ message: "Etsy batch compute failed", error: err.message });
    }
};

const updateBaseCostForEtsyOrder = async (req, res) => {
    try {
        const { orderId, base_cost } = req.body;

        if (!orderId || base_cost === undefined || base_cost === null) {
            return res.status(400).json({ message: "Missing orderId or base cost" });
        }

        if (typeof base_cost !== "number" || base_cost <= 0) {
            return res
                .status(400)
                .json({ message: "Base Cost must be a positive number" });
        }

        const order = await EtsyOrder.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        const oldBaseCost = Number(order.base_cost || 0);
        order.base_cost = base_cost;
        await order.save();

        if (oldBaseCost !== Number(base_cost)) {
            await logOrderHistory({
                orderDoc: order,
                action: "UPDATE_BASE_COST",
                description: "Etsy order base cost manually updated",
                changes: [
                    {
                        field: "base_cost",
                        from: oldBaseCost,
                        to: base_cost,
                    },
                ],
                user: req.user,
                context: {
                    source: "PORTAL",
                    ip: req.ip,
                    userAgent: req.headers["user-agent"],
                },
            });

            await logOrderLifecycleEvent({
                platform: "etsy",
                orderId,
                orderObjectId: order._id,
                shopId: order.shopId || null,
                stage: "BASE_COST",
                eventType: "ORDER_BASE_COST_UPDATED",
                status: "success",
                actorType: "user",
                actorId: req.user?._id,
                actorName: req.user?.name || req.user?.email || "",
                metadata: {
                    oldBaseCost,
                    newBaseCost: base_cost,
                },
            });
        }

        return res.status(200).json({
            message: "Etsy order base cost updated successfully",
            orderId,
            newBaseCost: base_cost,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Failed to update Etsy order base cost",
            error: error.message,
        });
    }
};

const resetBaseCostForEtsyOrder = async (req, res) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ message: "Missing orderId" });
        }

        const order = await EtsyOrder.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        const oldBaseCost = Number(order.base_cost || 0);
        const oldShippingGroups = Array.isArray(order.base_cost_shipping_groups)
            ? order.base_cost_shipping_groups
            : [];
        const oldComputedAt = order.base_cost_computed_at || null;
        const itemsWithCostBreakdown = Array.isArray(order.items)
            ? order.items.filter((item) => item?.cost_breakdown != null).length
            : 0;

        order.base_cost = 0;
        order.base_cost_shipping_groups = [];
        order.base_cost_computed_at = null;

        if (Array.isArray(order.items)) {
            for (const item of order.items) {
                item.cost_breakdown = undefined;
            }
        }

        await order.save();

        const changes = [];
        if (oldBaseCost !== 0) {
            changes.push({
                field: "base_cost",
                from: oldBaseCost,
                to: 0,
            });
        }

        if (oldShippingGroups.length > 0) {
            changes.push({
                field: "base_cost_shipping_groups",
                from: oldShippingGroups,
                to: [],
            });
        }

        if (oldComputedAt) {
            changes.push({
                field: "base_cost_computed_at",
                from: oldComputedAt,
                to: null,
            });
        }

        if (itemsWithCostBreakdown > 0) {
            changes.push({
                field: "items.cost_breakdown",
                from: `${itemsWithCostBreakdown} item(s) had cost breakdown`,
                to: "removed",
            });
        }

        if (changes.length > 0) {
            await logOrderHistory({
                orderDoc: order,
                action: "UPDATE_BASE_COST",
                description: "Etsy order base cost reset to 0 and item cost breakdown removed",
                changes,
                user: req.user,
                context: {
                    source: "PORTAL",
                    ip: req.ip,
                    userAgent: req.headers["user-agent"],
                },
            });
        }
        await logOrderLifecycleEvent({
            platform: "etsy",
            orderId,
            orderObjectId: order._id,
            shopId: order.shopId || null,
            stage: "RESET",
            eventType: "ORDER_RESET_COST",
            status: "success",
            actorType: "user",
            actorId: req.user?._id,
            actorName: req.user?.name || req.user?.email || "",
            metadata: {
                oldBaseCost,
                newBaseCost: 0,
                removedCostBreakdownCount: itemsWithCostBreakdown,
            },
        });

        return res.status(200).json({
            message: "Etsy order base cost reset successfully",
            orderId,
            base_cost: 0,
            removedCostBreakdownCount: itemsWithCostBreakdown,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Failed to reset Etsy order base cost",
            error: error.message,
        });
    }
};

/* ================== STATISTICS (GIỐNG AMAZON) ================== */

const getEtsyOrderStatistics = async (req, res) => {
    try {
        const {
            shopId,
            sellerCode,
            sellerId,
            from,
            to,
            search,
            shipping_type,
        } = req.query;

        // ===== BUILD MATCH =====
        const match = await buildEtsyOrderFilter(req.query, { includeTabFilters: false });

        if (shopId && mongoose.Types.ObjectId.isValid(shopId)) {
            match.shopId = new mongoose.Types.ObjectId(shopId);
        }
        if (sellerCode) match["seller.sellerCode"] = new RegExp(sellerCode, "i");
        if (sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
            match["seller.sellerId"] = new mongoose.Types.ObjectId(sellerId);
        }
        if (shipping_type) match.shipping_type = shipping_type;

        // Date range
        if (from || to) {
            match.saleDate = {};
            if (from) match.saleDate.$gte = new Date(from);
            if (to) match.saleDate.$lte = new Date(to);
        }

        // Search
        if (search) {
            const regex = new RegExp(search, "i");
            match.$or = [
                { orderId: regex },
                { "buyer.fullName": regex },
                { "buyer.userId": regex },
                { "items.sku": regex },
                { "items.itemName": regex },
                { "seller.sellerCode": regex },
            ];
        }

        // ===== FACET CONDITIONS =====
        const NO_COST_CENTER = {
            $and: [
                {
                    $or: [
                        { base_cost: { $exists: false } },
                        { base_cost: null },
                        { base_cost: 0 },
                    ],
                },
                { status: { $ne: "Cancelled" } },
            ],
        };
        const NO_COST_CENTER_NEW = {
            $and: [
                ...NO_COST_CENTER.$and,
                { $or: [{ status: "New" }, { status: "" }, { status: null }] },
            ],
        };
        const NO_COST_CENTER_FULFILLED = {
            $and: [...NO_COST_CENTER.$and, { status: "Fulfilled" }],
        };
        const NO_COST_CENTER_SHIPPED = {
            $and: [...NO_COST_CENTER.$and, { status: "Shipped" }],
        };
        const NO_PSD_MATCH = {
            $and: [
                { "items.snapshotImage": { $in: [null, ""] } },
                { status: { $ne: "Cancelled" } },
            ],
        };
        const OPEN_CASE_MATCH = { case: { $exists: true, $ne: [] } };

        const [stat] = await EtsyOrder.aggregate([
            { $match: match },
            {
                $facet: {
                    all: [{ $count: "c" }],
                    new: [
                        { $match: { $or: [{ status: "New" }, { status: "" }, { status: null }] } },
                        { $count: "c" },
                    ],
                    noCostCenter: [{ $match: NO_COST_CENTER }, { $count: "c" }],
                    noCostCenterNew: [{ $match: NO_COST_CENTER_NEW }, { $count: "c" }],
                    noCostCenterFulfilled: [{ $match: NO_COST_CENTER_FULFILLED }, { $count: "c" }],
                    noCostCenterShipped: [{ $match: NO_COST_CENTER_SHIPPED }, { $count: "c" }],
                    noPsd: [{ $match: NO_PSD_MATCH }, { $count: "c" }],
                    fulfilled: [{ $match: { status: "Fulfilled" } }, { $count: "c" }],
                    shipped: [{ $match: { status: "Shipped" } }, { $count: "c" }],
                    cancelled: [{ $match: { status: "Cancelled" } }, { $count: "c" }],
                    refund: [{ $match: { status: "Refund" } }, { $count: "c" }],
                    openCase: [{ $match: OPEN_CASE_MATCH }, { $count: "c" }],
                    addressUnchecked: [{ $match: ETSY_ADDRESS_UNCHECKED_MATCH }, { $count: "c" }],
                    invalidAddress: [
                        {
                            $match: {
                                $and: [
                                    { "address_validation.isValid": false },
                                    {
                                        $or: [
                                            { "address_validation.status": "invalid" },
                                            { "address_validation.status": { $exists: false } },
                                        ],
                                    },
                                ],
                            },
                        },
                        { $count: "c" },
                    ],
                },
            },
            {
                $project: {
                    all: { $ifNull: [{ $arrayElemAt: ["$all.c", 0] }, 0] },
                    new: { $ifNull: [{ $arrayElemAt: ["$new.c", 0] }, 0] },
                    noCostCenter: { $ifNull: [{ $arrayElemAt: ["$noCostCenter.c", 0] }, 0] },
                    noCostCenterByStatus: {
                        new: { $ifNull: [{ $arrayElemAt: ["$noCostCenterNew.c", 0] }, 0] },
                        fulfilled: { $ifNull: [{ $arrayElemAt: ["$noCostCenterFulfilled.c", 0] }, 0] },
                        shipped: { $ifNull: [{ $arrayElemAt: ["$noCostCenterShipped.c", 0] }, 0] },
                    },
                    noPsd: { $ifNull: [{ $arrayElemAt: ["$noPsd.c", 0] }, 0] },
                    fulfilled: { $ifNull: [{ $arrayElemAt: ["$fulfilled.c", 0] }, 0] },
                    shipped: { $ifNull: [{ $arrayElemAt: ["$shipped.c", 0] }, 0] },
                    cancelled: { $ifNull: [{ $arrayElemAt: ["$cancelled.c", 0] }, 0] },
                    refund: { $ifNull: [{ $arrayElemAt: ["$refund.c", 0] }, 0] },
                    openCase: { $ifNull: [{ $arrayElemAt: ["$openCase.c", 0] }, 0] },
                    addressUnchecked: { $ifNull: [{ $arrayElemAt: ["$addressUnchecked.c", 0] }, 0] },
                    invalidAddress: { $ifNull: [{ $arrayElemAt: ["$invalidAddress.c", 0] }, 0] },
                },
            },
        ]);

        return res.json(
            stat || {
                all: 0,
                new: 0,
                noCostCenter: 0,
                noCostCenterByStatus: {
                    new: 0,
                    fulfilled: 0,
                    shipped: 0,
                },
                noPsd: 0,
                fulfilled: 0,
                shipped: 0,
                cancelled: 0,
                refund: 0,
                openCase: 0,
                addressUnchecked: 0,
                invalidAddress: 0,
            }
        );
    } catch (err) {
        logger.error(`getEtsyOrderStatistics error: ${err.message}`);
        return res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Internal Server Error" });
    }
};

/* ================== CREATE ORDER (TỪ MODAL TEXT INPUT) ================== */

const SHIPPING_TYPE_ENUM = ["SecondDay", "Ground", "Overnight", "Economy", "Standard", "Expedited"];

const firstNonBlankString = (...values) => {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        const s = String(value).trim();
        if (s) return s;
    }
    return undefined;
};

const isMissingValue = (value) => {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value.trim() === "";
    return false;
};

const normalizeComparableAddressValue = (value) => String(value ?? "").trim();
const ETSY_ADDRESS_VALIDATION_SHIPPING_FIELDS = ["address1", "address2", "city", "state", "zipcode", "country"];

const hasEtsyShippingAddressChanged = (current = {}, next = {}) => (
    ETSY_ADDRESS_VALIDATION_SHIPPING_FIELDS.some((field) => (
        normalizeComparableAddressValue(current?.[field]) !== normalizeComparableAddressValue(next?.[field])
    ))
);

const isEmptyObject = (value) => (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
);

const normalizeEtsyShippingPayload = (body = {}) => {
    const shipping = body.shipping && typeof body.shipping === "object" ? body.shipping : {};
    const customer = body.customer_infor && typeof body.customer_infor === "object" ? body.customer_infor : {};

    return {
        name: firstNonBlankString(
            shipping.name,
            shipping.fullName,
            shipping.full_name,
            customer.name,
            body.shipName,
            body.shippingName
        ),
        address1: firstNonBlankString(
            shipping.address1,
            shipping.address_1,
            shipping.address,
            shipping.street,
            shipping.street1,
            customer.address,
            customer.address1,
            customer.address_1,
            body.address1,
            body.address
        ),
        address2: firstNonBlankString(
            shipping.address2,
            shipping.address_2,
            shipping.street2,
            customer.address_2,
            customer.address2,
            body.address2,
            body.address_2
        ),
        city: firstNonBlankString(
            shipping.city,
            customer.city,
            body.city
        ),
        state: firstNonBlankString(
            shipping.state,
            shipping.province,
            customer.state,
            customer.province,
            body.state
        ),
        zipcode: firstNonBlankString(
            shipping.zipcode,
            shipping.zip_code,
            shipping.zip,
            shipping.postalCode,
            shipping.postal_code,
            customer.zip_code,
            customer.zipcode,
            customer.zip,
            customer.postalCode,
            customer.postal_code,
            body.zipcode,
            body.zip_code,
            body.zip
        ),
        country: firstNonBlankString(
            shipping.country,
            shipping.countryCode,
            shipping.country_code,
            customer.country,
            customer.countryCode,
            customer.country_code,
            body.country
        ),
    };
};

const pickEtsyShippingAddress = (shipping = {}) => ({
    name: shipping?.name || "",
    address1: shipping?.address1 || "",
    address2: shipping?.address2 || "",
    city: shipping?.city || "",
    state: shipping?.state || "",
    zipcode: shipping?.zipcode || "",
    country: shipping?.country || "",
});

const buildEtsyCustomerInfoFromShipping = (order, shipping = {}) => ({
    email: order.customer_infor?.email || "",
    name: shipping.name || order.buyer?.fullName || order.buyer?.display || "",
    address: shipping.address1 || "",
    address_2: shipping.address2 || "",
    province: shipping.state || "",
    city: shipping.city || "",
    state: shipping.state || "",
    zip_code: shipping.zipcode || "",
    country: shipping.country || "",
    phone_number: order.customer_infor?.phone_number || "",
});

const buildEtsyAddressChanges = (before = {}, after = {}) => (
    ["name", "address1", "address2", "city", "state", "zipcode", "country"]
        .filter((field) => normalizeComparableAddressValue(before[field]) !== normalizeComparableAddressValue(after[field]))
        .map((field) => ({
            field: `shipping.${field}`,
            from: before[field] || "",
            to: after[field] || "",
        }))
);

const MAX_CUSTOM_TEXT_FIELDS = 50;
const MAX_CUSTOM_FILES = 50;
const MAX_CUSTOM_STRING = 2000;
const CUSTOM_FILE_CONTENT_KEYS = ["base64", "buffer", "data", "fileContent", "content"];

function sanitizeCustomString(value, max = MAX_CUSTOM_STRING) {
    if (value === null || value === undefined) return "";
    return String(value).trim().slice(0, max);
}

function maskUrlForLog(url) {
    const text = sanitizeCustomString(url, 4000);
    if (!text) return "";
    try {
        const parsed = new URL(text);
        parsed.search = parsed.search ? "?..." : "";
        parsed.hash = parsed.hash ? "#..." : "";
        return parsed.toString();
    } catch (_err) {
        const idx = text.indexOf("?");
        return idx === -1 ? text : `${text.slice(0, idx)}?...`;
    }
}

function hasUnsafeInlineFileContent(value) {
    if (!value || typeof value !== "object") return false;
    return CUSTOM_FILE_CONTENT_KEYS.some((key) => {
        const raw = value[key];
        if (typeof raw !== "string") return raw !== undefined && raw !== null;
        return raw.length > MAX_CUSTOM_STRING || raw.startsWith("data:");
    });
}

function sanitizeCustomRaw(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (CUSTOM_FILE_CONTENT_KEYS.includes(key)) continue;
        if (raw && typeof raw === "object") continue;
        out[key] = typeof raw === "string" ? sanitizeCustomString(raw) : raw;
    }
    return Object.keys(out).length ? out : null;
}

function normalizeCustomizations(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { textFields: [], buyerNote: "", raw: null };
    }

    const textFields = Array.isArray(input.textFields)
        ? input.textFields
            .slice(0, MAX_CUSTOM_TEXT_FIELDS)
            .map((field) => ({
                name: decodeEtsyHtmlEntities(sanitizeCustomString(field?.name)),
                value: decodeEtsyHtmlEntities(sanitizeCustomString(field?.value)),
                source: sanitizeCustomString(field?.source),
            }))
            .filter((field) => field.name || field.value)
        : [];

    return {
        textFields,
        buyerNote: decodeEtsyHtmlEntities(sanitizeCustomString(input.buyerNote)),
        raw: decodeEtsyHtmlEntitiesInObject(sanitizeCustomRaw(input.raw)),
    };
}

function normalizeCustomFileStatus(file, { useExternalCustomFileLink = false } = {}) {
    if (file?.storageUrl) return "downloaded";
    const status = sanitizeCustomString(file?.status);
    if (["pending_download", "downloaded", "failed", "skipped", "external_link"].includes(status)) return status;
    const source = sanitizeCustomString(file?.source);
    const downloadUrl = sanitizeCustomString(file?.downloadUrl || file?.url, 4000);
    if (useExternalCustomFileLink && source === "etsy_order_detail_dom" && downloadUrl.includes("/ipf/")) {
        return "external_link";
    }
    if (file?.downloadUrl || file?.previewUrl) return "pending_download";
    return "skipped";
}

function normalizeCustomFiles(input = [], fallback = {}) {
    if (!Array.isArray(input)) return [];
    return input
        .slice(0, MAX_CUSTOM_FILES)
        .filter((file) => file && typeof file === "object" && !hasUnsafeInlineFileContent(file))
        .map((file) => {
            const transactionId = sanitizeCustomString(file.transactionId || fallback.transactionId);
            const listingId = sanitizeCustomString(file.listingId || fallback.listingId);
            const now = new Date();
            return {
                source: sanitizeCustomString(file.source),
                fileName: sanitizeCustomString(file.fileName || file.name || file.filename),
                mimeType: sanitizeCustomString(file.mimeType || file.type),
                size: toNumber(file.size),
                downloadUrl: sanitizeCustomString(file.downloadUrl || file.url, 4000),
                previewUrl: sanitizeCustomString(file.previewUrl || file.thumbnailUrl, 4000),
                storageUrl: sanitizeCustomString(file.storageUrl, 4000),
                etsyFileId: sanitizeCustomString(file.etsyFileId || file.fileId || file.id),
                transactionId,
                listingId,
                matchConfidence: sanitizeCustomString(file.matchConfidence),
                status: normalizeCustomFileStatus(file, {
                    useExternalCustomFileLink: !!(fallback.useExternalCustomFileLink || file.useExternalCustomFileLink),
                }),
                errorMessage: sanitizeCustomString(file.errorMessage),
                downloadedAt: file.downloadedAt ? toDate(file.downloadedAt) : null,
                createdAt: file.createdAt ? toDate(file.createdAt) || now : now,
                updatedAt: now,
            };
        })
        .filter((file) => (
            file.fileName ||
            file.downloadUrl ||
            file.previewUrl ||
            file.storageUrl ||
            file.etsyFileId
        ));
}

function getCustomFileDedupKey(file = {}) {
    if (file.etsyFileId) return `etsyFileId:${file.etsyFileId}`;
    if (file.downloadUrl) return `downloadUrl:${file.downloadUrl}`;
    if (file.previewUrl) return `previewUrl:${file.previewUrl}`;
    if (file.transactionId && file.fileName) return `txFile:${file.transactionId}:${file.fileName}`;
    if (file.listingId && file.fileName) return `listingFile:${file.listingId}:${file.fileName}`;
    return "";
}

function mergeCustomFile(existing, incoming) {
    const existingDownloaded = !!existing.storageUrl || existing.status === "downloaded";
    const existingExternalLink = existing.status === "external_link" && !!existing.downloadUrl && !existing.storageUrl;
    const merged = { ...existing };
    const preserveKeys = existingDownloaded || existingExternalLink
        ? new Set(["storageUrl", "status", "downloadedAt", "errorMessage"])
        : new Set(["downloadedAt"]);

    for (const [key, value] of Object.entries(incoming || {})) {
        if (preserveKeys.has(key)) continue;
        if ((merged[key] === null || merged[key] === undefined || merged[key] === "") && value !== null && value !== undefined && value !== "") {
            merged[key] = value;
        }
    }

    merged.updatedAt = new Date();
    return merged;
}

function mergeCustomFiles(existingFiles = [], incomingFiles = []) {
    const merged = Array.isArray(existingFiles) ? existingFiles.map((file) => ({ ...(file?.toObject?.() || file) })) : [];
    let added = 0;
    let mergedCount = 0;
    const indexByKey = new Map();

    merged.forEach((file, index) => {
        const key = getCustomFileDedupKey(file);
        if (key) indexByKey.set(key, index);
    });

    for (const incoming of Array.isArray(incomingFiles) ? incomingFiles : []) {
        const key = getCustomFileDedupKey(incoming);
        const existingIndex = key ? indexByKey.get(key) : -1;
        if (existingIndex !== undefined && existingIndex >= 0) {
            merged[existingIndex] = mergeCustomFile(merged[existingIndex], incoming);
            mergedCount += 1;
            continue;
        }
        merged.push(incoming);
        added += 1;
        if (key) indexByKey.set(key, merged.length - 1);
    }

    return {
        files: merged.slice(0, MAX_CUSTOM_FILES),
        added,
        merged: mergedCount,
        changed: added > 0 || mergedCount > 0,
    };
}

function mergeCustomizations(existing = {}, incoming = {}) {
    const current = normalizeCustomizations(existing);
    const next = normalizeCustomizations(incoming);
    const seen = new Set(current.textFields.map((field) => `${field.name}::${field.value}::${field.source}`));
    let addedTextFields = 0;

    for (const field of next.textFields) {
        const key = `${field.name}::${field.value}::${field.source}`;
        if (seen.has(key)) continue;
        current.textFields.push(field);
        seen.add(key);
        addedTextFields += 1;
    }

    if (current.textFields.length > MAX_CUSTOM_TEXT_FIELDS) current.textFields = current.textFields.slice(0, MAX_CUSTOM_TEXT_FIELDS);
    const buyerNoteChanged = !!next.buyerNote && next.buyerNote !== current.buyerNote;
    const rawChanged = !!next.raw;
    if (buyerNoteChanged) current.buyerNote = next.buyerNote;
    if (rawChanged) current.raw = next.raw;

    return {
        customizations: current,
        addedTextFields,
        changed: addedTextFields > 0 || buyerNoteChanged || rawChanged,
    };
}

function summarizeCustomData(items = []) {
    const summary = {
        totalItems: Array.isArray(items) ? items.length : 0,
        itemsWithCustomText: 0,
        itemsWithCustomFiles: 0,
        totalCustomFiles: 0,
    };
    for (const item of items || []) {
        const textCount = item?.customizations?.textFields?.length || 0;
        const fileCount = item?.customFiles?.length || 0;
        if (textCount > 0 || item?.customizations?.buyerNote) summary.itemsWithCustomText += 1;
        if (fileCount > 0) summary.itemsWithCustomFiles += 1;
        summary.totalCustomFiles += fileCount;
    }
    return summary;
}

function urlHasTokenLikeParts(url) {
    const text = String(url || "");
    if (!text) return false;
    try {
        const parsed = new URL(text);
        return !!parsed.search || !!parsed.hash;
    } catch (_err) {
        return text.includes("?");
    }
}

function maskCustomFilesForResponse(files = [], { includeDownloadUrl = false, includePreviewUrl = false, includeExternalUrl = false } = {}) {
    return (Array.isArray(files) ? files : []).map((file) => {
        const isExternalLink = file.status === "external_link" && !file.storageUrl && !!file.downloadUrl;
        return {
            source: file.source || "",
            fileName: file.fileName || "",
            mimeType: file.mimeType || "",
            size: file.size ?? null,
            downloadUrl: includeDownloadUrl ? file.downloadUrl || "" : undefined,
            downloadUrlMasked: file.downloadUrl ? maskUrlForLog(file.downloadUrl) : "",
            externalUrl: includeExternalUrl && isExternalLink ? file.downloadUrl || "" : undefined,
            externalUrlMasked: isExternalLink ? maskUrlForLog(file.downloadUrl) : "",
            previewUrl: includePreviewUrl || !urlHasTokenLikeParts(file.previewUrl) ? file.previewUrl || "" : undefined,
            previewUrlMasked: file.previewUrl ? maskUrlForLog(file.previewUrl) : "",
            storageUrl: file.storageUrl || "",
            etsyFileId: file.etsyFileId || "",
            transactionId: file.transactionId || "",
            listingId: file.listingId || "",
            matchConfidence: file.matchConfidence || "",
            status: file.status || "",
            errorMessage: file.errorMessage || "",
            downloadedAt: file.downloadedAt || null,
            createdAt: file.createdAt || null,
            updatedAt: file.updatedAt || null,
        };
    });
}

function buildCustomItemResponseFields(item = {}, customFileOptions = {}) {
    const customizations = item.customizations || { textFields: [], buyerNote: "", raw: null };
    const customFiles = Array.isArray(item.customFiles) ? item.customFiles : [];
    return {
        customizations,
        customFiles: maskCustomFilesForResponse(customFiles, customFileOptions),
        customTextCount: (customizations.textFields || []).length + (customizations.buyerNote ? 1 : 0),
        customFileCount: customFiles.length,
        pendingCustomFileCount: customFiles.filter((file) => file?.status === "pending_download").length,
        downloadedCustomFileCount: customFiles.filter((file) => file?.status === "downloaded").length,
    };
}

const deriveSellerCodeFromItems = (items = []) => {
    for (const item of items) {
        const sellerCode = getSellerCodeFromSku(item?.mapped_sku || item?.sku);
        if (sellerCode) return sellerCode;
    }
    return undefined;
};

const assignEtsyItemSellers = async (items = []) => {
    const sellerCodes = Array.from(new Set(items
        .map((item) => getSellerCodeFromSku(item?.mapped_sku || item?.sku))
        .filter(Boolean)));
    if (!sellerCodes.length) return;

    const users = await User.find({ employee_id: { $in: sellerCodes } }, { _id: 1, employee_id: 1 }).lean();
    const userByCode = new Map(users.map((user) => [String(user.employee_id).toUpperCase(), user]));
    for (const item of items) {
        const sellerCode = getSellerCodeFromSku(item?.mapped_sku || item?.sku);
        if (!sellerCode) continue;
        const user = userByCode.get(sellerCode.toUpperCase());
        item.seller = { sellerCode, sellerId: user?._id };
    }
};

const ETSY_ORDER_BACKFILL_WINDOW_DAYS = Number(process.env.ETSY_ORDER_BACKFILL_WINDOW_DAYS || 2);
const isForceTrue = (value) => value === true || String(value || "").toLowerCase() === "true";
const isExistingEtsyOrderTooOldForBackfill = (order) => {
    const days = Number.isFinite(ETSY_ORDER_BACKFILL_WINDOW_DAYS) ? ETSY_ORDER_BACKFILL_WINDOW_DAYS : 2;
    if (days <= 0) return false;
    const baseDate = order?.createdAt || order?.created_at || order?.saleDate;
    const createdAt = baseDate ? new Date(baseDate) : null;
    if (!createdAt || !Number.isFinite(createdAt.getTime())) return false;
    return createdAt.getTime() < Date.now() - days * 24 * 60 * 60 * 1000;
};

const normalizeItem = (raw, idx, skuMappingConfigs = []) => {
    const transactionId = String(raw?.transactionId ?? "").trim();
    if (!transactionId) {
        const err = new Error(`items[${idx}].transactionId is required`);
        err.status = 400;
        throw err;
    }

    let variations = raw?.variations;
    if (typeof variations === "string") variations = parseVariations(variations);
    if (!variations || typeof variations !== "object") variations = {};
    variations = normalizeEtsyVariationObject(variations);
    const listingId = firstNonBlankString(raw?.listingId, raw?.listing_id, raw?.listingID, raw?.listing);
    const customizations = normalizeCustomizations(raw?.customizations);
    const customFiles = normalizeCustomFiles(raw?.customFiles, {
        transactionId,
        listingId,
        useExternalCustomFileLink: raw?.useExternalCustomFileLink === true,
    });
    const sku = firstNonBlankString(
        raw?.sku,
        raw?.SKU,
        raw?.productSku,
        raw?.product_sku,
        raw?.productIdentifier,
        raw?.product_identifier
    );
    const mappedSku = firstNonBlankString(raw?.mapped_sku, raw?.mappedSku)
        || resolveMappedSkuFromConfigs(sku, skuMappingConfigs)?.mapped_sku
        || undefined;

    return {
        transactionId,
        listingId,
        sku,
        mapped_sku: mappedSku,
        itemName: raw?.itemName ? String(raw.itemName).trim() : undefined,
        quantity: toInt(raw?.quantity),
        unitPrice: toNumber(raw?.unitPrice),
        itemTotal: toNumber(raw?.itemTotal),
        variationsRaw: raw?.variationsRaw ? String(raw.variationsRaw) : undefined,
        variations,
        cost_breakdown: raw?.cost_breakdown ?? null,
        baseImage: raw?.baseImage && typeof raw.baseImage === "object" ? {
            imageUrl: raw.baseImage.imageUrl ? String(raw.baseImage.imageUrl) : undefined,
            width: toInt(raw.baseImage.width),
            height: toInt(raw.baseImage.height),
        } : undefined,
        customizations,
        customFiles,
    };
};

const buildEtsyOrderPayload = (body, skuMappingConfigs = []) => {
    const orderId = String(body?.orderId ?? "").trim();
    if (!orderId) {
        const err = new Error("orderId is required");
        err.status = 400;
        throw err;
    }

    const shopIdRaw = String(body?.shopId ?? "").trim();
    if (!mongoose.Types.ObjectId.isValid(shopIdRaw)) {
        const err = new Error("shopId is required and must be a valid ObjectId");
        err.status = 400;
        throw err;
    }

    const useExternalCustomFileLink = body?.useExternalCustomFileLink === true;
    const items = Array.isArray(body?.items)
        ? body.items.map((item, idx) => normalizeItem({
            ...item,
            useExternalCustomFileLink: item?.useExternalCustomFileLink === true || useExternalCustomFileLink,
        }, idx, skuMappingConfigs))
        : [];
    const customSummary = summarizeCustomData(items);

    const txSet = new Set();
    for (const it of items) {
        if (txSet.has(it.transactionId)) {
            const err = new Error(`Duplicate transactionId in items: ${it.transactionId}`);
            err.status = 400;
            throw err;
        }
        txSet.add(it.transactionId);
    }

    const sellerIdRaw = body?.seller?.sellerId;
    const sellerId = sellerIdRaw && mongoose.Types.ObjectId.isValid(sellerIdRaw)
        ? new mongoose.Types.ObjectId(sellerIdRaw)
        : undefined;
    const sellerCode = firstNonBlankString(body?.seller?.sellerCode) || deriveSellerCodeFromItems(items);

    const shippingType = body?.shipping_type && SHIPPING_TYPE_ENUM.includes(body.shipping_type)
        ? body.shipping_type
        : "Standard";

    logger.debug({
        tag: "ETSY_CUSTOM_DATA_IMPORT_PAYLOAD_SUMMARY",
        orderId,
        shopId: String(shopIdRaw),
        ...customSummary,
    });

    return {
        orderId,
        shopId: new mongoose.Types.ObjectId(shopIdRaw),

        saleDate: toDate(body?.saleDate),
        paidAt: toDate(body?.paidAt),
        shippedAt: toDate(body?.shippedAt),

        status: body?.status ? String(body.status).trim() : "New",

        orderType: body?.orderType ? String(body.orderType) : undefined,
        listingsType: body?.listingsType ? String(body.listingsType) : undefined,
        paymentType: body?.paymentType ? String(body.paymentType) : undefined,
        paymentMethod: body?.paymentMethod ? String(body.paymentMethod) : undefined,
        currency: body?.currency ? String(body.currency).trim().slice(0, 3).toUpperCase() : undefined,

        buyer: {
            userId: body?.buyer?.userId ? String(body.buyer.userId) : undefined,
            fullName: body?.buyer?.fullName ? String(body.buyer.fullName) : undefined,
            firstName: body?.buyer?.firstName ? String(body.buyer.firstName) : undefined,
            lastName: body?.buyer?.lastName ? String(body.buyer.lastName) : undefined,
            display: body?.buyer?.display ? String(body.buyer.display) : undefined,
        },

        seller: {
            sellerId,
            sellerCode,
        },

        coupon: {
            code: body?.coupon?.code ? String(body.coupon.code) : undefined,
            details: body?.coupon?.details ? String(body.coupon.details) : undefined,
        },

        shipping: normalizeEtsyShippingPayload(body),

        shipping_type: shippingType,

        totals: {
            orderValue: toNumber(body?.totals?.orderValue),
            shipping: toNumber(body?.totals?.shipping),
            salesTax: toNumber(body?.totals?.salesTax),
            orderTotal: toNumber(body?.totals?.orderTotal),
            cardProcessingFees: toNumber(body?.totals?.cardProcessingFees),
            orderNet: toNumber(body?.totals?.orderNet),
            fee: toNumber(body?.totals?.fee),
            adjustedOrderTotal: toNumber(body?.totals?.adjustedOrderTotal),
            adjustedCardProcessingFees: toNumber(body?.totals?.adjustedCardProcessingFees),
            adjustedNet: toNumber(body?.totals?.adjustedNet),
            adjustedOrderValue: toNumber(body?.totals?.adjustedOrderValue),
            adjustedShipping: toNumber(body?.totals?.adjustedShipping),
            adjustedSalesTax: toNumber(body?.totals?.adjustedSalesTax),
            orderShipping: toNumber(body?.totals?.orderShipping),
            orderSalesTax: toNumber(body?.totals?.orderSalesTax),
            discountAmount: toNumber(body?.totals?.discountAmount),
            shippingDiscount: toNumber(body?.totals?.shippingDiscount),
            inPersonDiscount: toNumber(body?.totals?.inPersonDiscount),
            vatPaidByBuyer: toNumber(body?.totals?.vatPaidByBuyer),
        },

        numberOfItems: toInt(body?.numberOfItems) ?? items.reduce((s, i) => s + (i.quantity || 0), 0),

        items,
    };
};

const backfillExistingEtsyOrder = async (existing, payload) => {
    const incomingItems = Array.isArray(payload.items) ? payload.items : [];
    const existingItems = Array.isArray(existing.items) ? existing.items : [];
    const existingItemsCount = existingItems.length;
    const itemByTx = new Map();
    const itemByListingSku = new Map();
    const itemByListing = new Map();
    const itemBySku = new Map();

    for (const item of existingItems) {
        if (item?.transactionId) itemByTx.set(String(item.transactionId), item);
        if (item?.listingId && item?.sku) itemByListingSku.set(`${item.listingId}::${item.sku}`, item);
        if (item?.listingId) itemByListing.set(String(item.listingId), item);
        if (item?.sku) itemBySku.set(String(item.sku), item);
    }

    let matchedItems = 0;
    let updatedItems = 0;
    let addedItems = 0;
    let skuBackfilled = 0;
    let listingIdBackfilled = 0;
    let customTextBackfilled = 0;
    let customFilesBackfilled = 0;
    let customFilesMerged = 0;
    const samples = [];

    const backfillField = (target, source, field) => {
        if (!source || isMissingValue(source[field]) || !isMissingValue(target[field])) return false;
        target[field] = source[field];
        return true;
    };

    for (const incoming of incomingItems) {
        const tx = String(incoming.transactionId || "");
        const listingSkuKey = incoming.listingId && incoming.sku ? `${incoming.listingId}::${incoming.sku}` : "";
        const current =
            itemByTx.get(tx) ||
            (listingSkuKey ? itemByListingSku.get(listingSkuKey) : null) ||
            (incoming.listingId ? itemByListing.get(String(incoming.listingId)) : null) ||
            (incoming.sku ? itemBySku.get(String(incoming.sku)) : null);

        if (!current) {
            existing.items.push(incoming);
            addedItems += 1;
            customTextBackfilled += incoming.customizations?.textFields?.length || 0;
            customFilesBackfilled += incoming.customFiles?.length || 0;
            samples.push({
                transactionId: tx,
                action: "added",
                oldSku: "",
                newSku: incoming.sku || "",
                oldListingId: "",
                newListingId: incoming.listingId || "",
            });
            continue;
        }

        matchedItems += 1;
        const oldSku = current.sku || "";
        const oldListingId = current.listingId || "";
        let itemChanged = false;

        if (backfillField(current, incoming, "sku")) {
            skuBackfilled += 1;
            itemChanged = true;
        }
        if (backfillField(current, incoming, "mapped_sku")) {
            itemChanged = true;
        }
        if (backfillField(current, incoming, "seller")) {
            itemChanged = true;
        }
        if (backfillField(current, incoming, "listingId")) {
            listingIdBackfilled += 1;
            itemChanged = true;
        }
        if (backfillField(current, incoming, "itemName")) itemChanged = true;
        if (backfillField(current, incoming, "variationsRaw")) itemChanged = true;

        if ((isMissingValue(current.baseImage?.imageUrl)) && incoming.baseImage?.imageUrl) {
            if (!current.baseImage) current.baseImage = {};
            current.baseImage.imageUrl = incoming.baseImage.imageUrl;
            if (isMissingValue(current.baseImage.width) && incoming.baseImage.width != null) current.baseImage.width = incoming.baseImage.width;
            if (isMissingValue(current.baseImage.height) && incoming.baseImage.height != null) current.baseImage.height = incoming.baseImage.height;
            itemChanged = true;
        }

        if ((!current.variations || isEmptyObject(current.variations)) && incoming.variations && !isEmptyObject(incoming.variations)) {
            current.variations = incoming.variations;
            itemChanged = true;
        }

        if ((current.cost_breakdown === null || current.cost_breakdown === undefined) && incoming.cost_breakdown !== null && incoming.cost_breakdown !== undefined) {
            current.cost_breakdown = incoming.cost_breakdown;
            itemChanged = true;
        }

        const mergedCustomizations = mergeCustomizations(current.customizations, incoming.customizations);
        if (mergedCustomizations.changed) {
            current.customizations = mergedCustomizations.customizations;
            customTextBackfilled += mergedCustomizations.addedTextFields;
            itemChanged = true;
        }

        const mergedCustomFiles = mergeCustomFiles(current.customFiles, incoming.customFiles);
        if (mergedCustomFiles.changed) {
            current.customFiles = mergedCustomFiles.files;
            customFilesBackfilled += mergedCustomFiles.added;
            customFilesMerged += mergedCustomFiles.merged;
            itemChanged = true;
        }

        if (itemChanged) {
            updatedItems += 1;
            samples.push({
                transactionId: tx,
                action: "backfilled",
                oldSku,
                newSku: current.sku || "",
                oldListingId,
                newListingId: current.listingId || "",
            });
        }
    }

    let sellerBackfilled = false;
    if (isMissingValue(existing.seller?.sellerCode) && payload.seller?.sellerCode) {
        if (!existing.seller) existing.seller = {};
        existing.seller.sellerCode = payload.seller.sellerCode;
        sellerBackfilled = true;
    }

    let shippingBackfilled = false;
    let shippingAddressBackfilled = false;
    const shippingFields = ["name", "address1", "address2", "city", "state", "zipcode", "country"];
    for (const field of shippingFields) {
        if (!payload.shipping || isMissingValue(payload.shipping[field])) continue;
        if (!existing.shipping) existing.shipping = {};
        if (isMissingValue(existing.shipping[field]) || existing.shipping[field] !== payload.shipping[field]) {
            existing.shipping[field] = payload.shipping[field];
            shippingBackfilled = true;
            if (ETSY_ADDRESS_VALIDATION_SHIPPING_FIELDS.includes(field)) {
                shippingAddressBackfilled = true;
            }
        }
    }

    if (shippingBackfilled) {
        existing.address_validation = {
            provider: "smarty",
            scope: "etsy_us_street",
            envSource: "ETSY_US_STREET_SMARTY_*",
            status: "pending",
            isValid: null,
            checkedAt: null,
            httpStatus: null,
            errorCode: null,
            errorMessage: null,
            retryable: false,
            accountIssue: false,
            smartyResponse: null,
        };
    }

    const backfilled = updatedItems > 0 || addedItems > 0 || sellerBackfilled || shippingBackfilled;
    if (backfilled) {
        existing.numberOfItems = existing.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
        if (updatedItems > 0 || addedItems > 0) existing.markModified("items");
        if (sellerBackfilled) existing.markModified("seller");
        if (shippingBackfilled) {
            existing.markModified("shipping");
            existing.markModified("address_validation");
        }
        await existing.save();
    }

    logger.debug({
        tag: "ETSY_ORDER_BACKFILL",
        shopId: String(payload.shopId),
        orderId: payload.orderId,
        existingItems: existingItemsCount,
        incomingItems: incomingItems.length,
        matchedItems,
        addedItems,
        skuBackfilled,
        listingIdBackfilled,
        shippingBackfilled,
        shippingAddressBackfilled,
        customTextBackfilled,
        customFilesBackfilled,
        customFilesMerged,
        sample: samples.slice(0, 20),
    });

    return {
        backfilled,
        updatedItems,
        addedItems,
        skuBackfilled,
        listingIdBackfilled,
        shippingBackfilled,
        customTextBackfilled,
        customFilesBackfilled,
        customFilesMerged,
        customSummary: summarizeCustomData(existing.items || []),
    };
};

const createOrder = async (req, res) => {
    try {
        const skuMappingConfigs = await loadActiveEtsySkuMappingConfigs();
        const payload = buildEtsyOrderPayload(req.body || {}, skuMappingConfigs);
        await assignEtsyItemSellers(payload.items);

        const existing = await EtsyOrder.findOne({ orderId: payload.orderId, shopId: payload.shopId });
        if (existing) {
            if (!isForceTrue(req.body?.forceBackfill) && isExistingEtsyOrderTooOldForBackfill(existing)) {
                return res.status(200).json({
                    ok: true,
                    duplicated: true,
                    skipped: true,
                    reason: "existing_order_outside_backfill_window",
                    orderId: payload.orderId,
                    backfilled: false,
                    autoBaseCost: null,
                });
            }

            const result = await backfillExistingEtsyOrder(existing, payload);
            if (!result.backfilled) {
                return res.status(200).json({
                    ok: true,
                    duplicated: true,
                    skipped: true,
                    reason: "existing_order_no_backfill_changes",
                    orderId: payload.orderId,
                    backfilled: false,
                    updatedItems: 0,
                    addedItems: 0,
                    autoBaseCost: null,
                    customSummary: result.customSummary,
                });
            }

            if (payload.seller?.sellerCode) {
                await fillSellerIfMissing(payload.orderId, payload.shopId, payload.seller.sellerCode);
            }
            await validateAddressIfNeeded(existing, { force: result.shippingAddressBackfilled });
            let autoBaseCost = null;
            if (Array.isArray(existing.items) && existing.items.length > 0) {
                try {
                    const computed = await calculateEtsyCost(existing);
                    autoBaseCost = {
                        ok: true,
                        base_cost: existing.base_cost,
                        preferred_vendor_id: computed.preferredVendorId || null,
                    };
                    await logOrderLifecycleEvent({
                        platform: "etsy",
                        orderId: payload.orderId,
                        orderObjectId: existing._id,
                        shopId: payload.shopId,
                        stage: "AUTO_COST",
                        eventType: "AUTO_COST_SUCCESS",
                        status: "success",
                        actorType: "system",
                        message: "Auto cost computed after Etsy order backfill",
                        metadata: {
                            base_cost: existing.base_cost,
                            preferred_vendor_id: computed.preferredVendorId || null,
                        },
                    });
                } catch (computeErr) {
                    logger.error(`Auto-compute cost failed for Etsy order ${payload.orderId}: ${computeErr.message}`);
                    autoBaseCost = { ok: false, error: computeErr.message };
                    await logOrderLifecycleEvent({
                        platform: "etsy",
                        orderId: payload.orderId,
                        orderObjectId: existing._id,
                        shopId: payload.shopId,
                        stage: "AUTO_COST",
                        eventType: "AUTO_COST_FAILED",
                        status: "failed",
                        actorType: "system",
                        reason: computeErr.message,
                    });
                }
            }
            await logOrderLifecycleEvent({
                platform: "etsy",
                orderId: payload.orderId,
                orderObjectId: existing._id,
                shopId: payload.shopId,
                stage: "IMPORT",
                eventType: "ORDER_BACKFILLED",
                status: "success",
                actorType: "api",
                metadata: {
                    backfilled: result.backfilled,
                    updatedItems: result.updatedItems,
                    addedItems: result.addedItems,
                },
            });
            logger.debug({
                tag: "ETSY_CUSTOM_DATA_BACKFILL_SUMMARY",
                orderId: payload.orderId,
                shopId: String(payload.shopId),
                customTextBackfilled: result.customTextBackfilled,
                customFilesBackfilled: result.customFilesBackfilled,
                customFilesMerged: result.customFilesMerged,
                autoBaseCost,
                customSummary: result.customSummary,
            });
            return res.status(200).json({
                ok: true,
                duplicated: true,
                backfilled: result.backfilled,
                orderId: payload.orderId,
                updatedItems: result.updatedItems,
                addedItems: result.addedItems,
                skuBackfilled: result.skuBackfilled,
                listingIdBackfilled: result.listingIdBackfilled,
                shippingBackfilled: result.shippingBackfilled,
                shippingAddressBackfilled: result.shippingAddressBackfilled,
                customTextBackfilled: result.customTextBackfilled,
                customFilesBackfilled: result.customFilesBackfilled,
                customFilesMerged: result.customFilesMerged,
                autoBaseCost,
                customSummary: result.customSummary,
            });
        }

        const doc = await EtsyOrder.create(payload);
        await validateAddressIfNeeded(doc, { force: true });
        if (payload.seller?.sellerCode) {
            await fillSellerIfMissing(payload.orderId, payload.shopId, payload.seller.sellerCode);
        }
        let autoBaseCost = null;
        if (Array.isArray(doc.items) && doc.items.length > 0) {
            try {
                const computed = await calculateEtsyCost(doc);
                autoBaseCost = {
                    ok: true,
                    base_cost: doc.base_cost,
                    preferred_vendor_id: computed.preferredVendorId || null,
                };
                await logOrderLifecycleEvent({
                    platform: "etsy",
                    orderId: payload.orderId,
                    orderObjectId: doc._id,
                    shopId: payload.shopId,
                    stage: "AUTO_COST",
                    eventType: "AUTO_COST_SUCCESS",
                    status: "success",
                    actorType: "system",
                    message: "Auto cost computed after Etsy order import",
                    metadata: {
                        base_cost: doc.base_cost,
                        preferred_vendor_id: computed.preferredVendorId || null,
                    },
                });
            } catch (computeErr) {
                logger.error(`Auto-compute cost failed for Etsy order ${payload.orderId}: ${computeErr.message}`);
                autoBaseCost = { ok: false, error: computeErr.message };
                await logOrderLifecycleEvent({
                    platform: "etsy",
                    orderId: payload.orderId,
                    orderObjectId: doc._id,
                    shopId: payload.shopId,
                    stage: "AUTO_COST",
                    eventType: "AUTO_COST_FAILED",
                    status: "failed",
                    actorType: "system",
                    reason: computeErr.message,
                });
            }
        }
        await logOrderLifecycleEvent({
            platform: "etsy",
            orderId: payload.orderId,
            orderObjectId: doc._id,
            shopId: payload.shopId,
            stage: "IMPORT",
            eventType: "ORDER_IMPORTED",
            status: "success",
            actorType: "api",
            metadata: { itemCount: Array.isArray(doc.items) ? doc.items.length : 0 },
        });
        logger.debug({
            tag: "ETSY_CUSTOM_DATA_CREATE_ORDER_SUMMARY",
            orderId: payload.orderId,
            shopId: String(payload.shopId),
            ...summarizeCustomData(payload.items || []),
            autoBaseCost,
        });
        return res.status(201).json({
            ok: true,
            created: true,
            orderId: doc.orderId,
            shopId: String(doc.shopId),
            autoBaseCost,
            customSummary: summarizeCustomData(doc.items || []),
        });
    } catch (err) {
        if (err?.status === 400) return res.status(400).json({ message: err.message });
        if (err?.code === 11000) return res.status(409).json({ message: "Duplicate orderId", keyValue: err.keyValue });
        if (err?.name === "ValidationError") return res.status(400).json({ message: err.message, errors: err.errors });
        logger.error(`createOrder error: ${err.message}`);
        return res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
};

const updateSumbittedoetsyStatus = async (req, res) => {
    try {
        const body = req.body || {};
        const orderId = String(body.orderId || body.oderid || "").trim();
        const shopId = String(body.shopId || "").trim();
        const nextStatus = toBooleanStrict(
            body.sumbittedoetsy ?? body.submittedToEtsy ?? body.submitted_to_etsy
        );

        if (!orderId) {
            return res.status(400).json({ ok: false, message: "orderId is required" });
        }
        if (!shopId) {
            return res.status(400).json({ ok: false, message: "shopId is required" });
        }
        if (!mongoose.Types.ObjectId.isValid(shopId)) {
            return res.status(400).json({ ok: false, message: "shopId must be a valid ObjectId" });
        }
        if (nextStatus === null) {
            return res.status(400).json({
                ok: false,
                message: "sumbittedoetsy must be true or false",
            });
        }

        const updated = await EtsyOrder.findOneAndUpdate(
            { orderId, shopId },
            { $set: { sumbittedoetsy: nextStatus } },
            { new: true }
        )
            .select({ orderId: 1, shopId: 1, sumbittedoetsy: 1, updatedAt: 1 })
            .lean();

        if (!updated) {
            return res.status(404).json({
                ok: false,
                message: "Etsy order not found",
                orderId,
                shopId,
            });
        }

        return res.json({
            ok: true,
            orderId: updated.orderId,
            shopId: String(updated.shopId),
            sumbittedoetsy: updated.sumbittedoetsy ?? false,
            updatedAt: updated.updatedAt,
        });
    } catch (err) {
        logger.error(`updateSumbittedoetsyStatus error: ${err.message}`);
        return res.status(500).json({ ok: false, message: "Internal Server Error", error: err.message });
    }
};

const updateEtsyOrderAddress = async (req, res) => {
    try {
        const incomingShipping = normalizeEtsyShippingPayload(req.body || {});
        const providedFields = Object.entries(incomingShipping)
            .filter(([, value]) => !isMissingValue(value))
            .map(([field]) => field);

        if (providedFields.length === 0) {
            return res.status(400).json({
                message: "At least one address field is required",
                acceptedFields: [
                    "shipping.name",
                    "shipping.address1",
                    "shipping.address2",
                    "shipping.city",
                    "shipping.state",
                    "shipping.zipcode",
                    "shipping.country",
                    "customer_infor.address",
                    "customer_infor.address_2",
                    "address1",
                    "address2",
                    "city",
                    "state",
                    "zipcode",
                    "country",
                ],
            });
        }

        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        const accessError = ensureSellerCanAccessEtsyOrder(req, order);
        if (accessError) {
            return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError });
        }

        const beforeShipping = pickEtsyShippingAddress(order.shipping || {});
        const beforeAddressValidation = order.address_validation
            ? order.address_validation.toObject?.() || order.address_validation
            : null;
        const beforeScaleOverallStatus = order.scale_overall_status || null;
        const nextShipping = {
            ...beforeShipping,
            ...Object.fromEntries(
                Object.entries(incomingShipping).filter(([, value]) => !isMissingValue(value))
            ),
        };

        const addressChanges = buildEtsyAddressChanges(beforeShipping, nextShipping);
        if (addressChanges.length === 0) {
            return res.status(200).json({
                message: "No address change",
                orderId: order.orderId,
                shipping: order.shipping || {},
                customer_infor: getEtsyCustomerInfo(order),
                address_validation: order.address_validation || null,
                scale_overall_status: order.scale_overall_status,
            });
        }

        const shippingAddressChanged = hasEtsyShippingAddressChanged(beforeShipping, nextShipping);
        order.shipping = nextShipping;
        order.customer_infor = buildEtsyCustomerInfoFromShipping(order, nextShipping);

        if (shippingAddressChanged) {
            order.address_validation = isUsShippingCountry(nextShipping.country)
                ? {
                    provider: "smarty",
                    scope: "etsy_us_street",
                    envSource: "ETSY_US_STREET_SMARTY_*",
                    status: "pending",
                    isValid: null,
                    checkedAt: null,
                    smartyResponse: null,
                }
                : {
                    provider: "smarty",
                    scope: "etsy_us_street",
                    envSource: "ETSY_US_STREET_SMARTY_*",
                    status: null,
                    isValid: null,
                    checkedAt: null,
                    smartyResponse: null,
                };
        }

        order.markModified("shipping");
        order.markModified("customer_infor");
        order.markModified("address_validation");
        await order.save();

        if (shippingAddressChanged) {
            await validateAddressIfNeeded(order, { force: isUsShippingCountry(nextShipping.country) });
        }

        const nextAddressInvalid = isEtsyAddressInvalid(order);
        if (nextAddressInvalid && order.scale_overall_status !== "Address Invalid") {
            order.scale_overall_status = "Address Invalid";
            await order.save();
        } else if (!nextAddressInvalid && beforeScaleOverallStatus === "Address Invalid") {
            order.scale_overall_status = "Pending";
            await order.save();
        }

        await logOrderHistory({
            orderDoc: order,
            action: "UPDATE_ADDRESS",
            description: "Etsy shipping address updated",
            changes: [
                ...addressChanges,
                {
                    field: "address_validation",
                    from: beforeAddressValidation,
                    to: order.address_validation || null,
                },
                ...(beforeScaleOverallStatus !== order.scale_overall_status
                    ? [{
                        field: "scale_overall_status",
                        from: beforeScaleOverallStatus,
                        to: order.scale_overall_status,
                    }]
                    : []),
            ],
            user: req.user,
            context: {
                source: "PORTAL",
                ip: req.ip,
                userAgent: req.headers["user-agent"],
            },
        });

        return res.json({
            message: "Etsy address updated",
            orderId: order.orderId,
            shipping: order.shipping || {},
            customer_infor: getEtsyCustomerInfo(order),
            address_validation: order.address_validation || null,
            scale_overall_status: order.scale_overall_status,
        });
    } catch (err) {
        return res.status(500).json({
            message: "Update Etsy address failed",
            error: err.message,
        });
    }
};

const updateEtsyOrderItemTracking = async (req, res) => {
    try {
        const orderId = String(req.params.orderId || "").trim();
        const transactionId = String(req.params.transactionId || req.params.orderItemId || "").trim();
        const body = req.body || {};

        const fulfillment = body.fulfillment !== undefined ? String(body.fulfillment).trim() : undefined;
        const tracking = body.tracking !== undefined ? String(body.tracking).trim() : undefined;
        const note = body.note !== undefined ? String(body.note) : undefined;
        const status = body.status !== undefined ? String(body.status).trim() : undefined;

        if (!orderId) return res.status(400).json({ ok: false, message: "orderId is required" });
        if (!transactionId) return res.status(400).json({ ok: false, message: "transactionId is required" });
        if (
            fulfillment === undefined &&
            tracking === undefined &&
            status === undefined &&
            note === undefined
        ) {
            return res.status(400).json({
                ok: false,
                message: "No updatable fields provided (fulfillment/tracking/status/note)",
            });
        }
        if (status && !ETSY_TRACKING_STATUSES.includes(status)) {
            return res.status(400).json({
                ok: false,
                message: "Invalid status",
                allowed: ETSY_TRACKING_STATUSES,
            });
        }

        let nextStatus;
        if (isEtsyCanceledStatus(status)) {
            nextStatus = "Cancelled";
        } else if (tracking !== undefined && tracking.length > 0) {
            nextStatus = "Shipped";
        } else {
            nextStatus = status;
        }

        const set = {
            "items.$.tracking_info.updated_at": new Date(),
        };
        if (fulfillment !== undefined) set["items.$.tracking_info.fulfillment"] = fulfillment;
        if (tracking !== undefined) set["items.$.tracking_info.tracking"] = tracking;
        if (note !== undefined) set["items.$.tracking_info.note"] = note;
        if (nextStatus !== undefined) set["items.$.tracking_info.status"] = nextStatus;

        const updated = await EtsyOrder.findOneAndUpdate(
            { orderId, "items.transactionId": transactionId },
            { $set: set },
            { new: true }
        ).lean();

        if (!updated) {
            return res.status(404).json({
                ok: false,
                message: "Etsy order or item not found",
                orderId,
                transactionId,
            });
        }

        const orderStatus = computeEtsyOrderStatusFromItems(updated.items || []);
        if (orderStatus !== updated.status) {
            await EtsyOrder.updateOne({ _id: updated._id }, { $set: { status: orderStatus } });
            updated.status = orderStatus;
        }

        const item = (updated.items || []).find((entry) => String(entry.transactionId) === transactionId);

        return res.json({
            ok: true,
            orderId: updated.orderId,
            shopId: String(updated.shopId || ""),
            transactionId,
            orderStatus: updated.status,
            tracking_info: item?.tracking_info || {},
            applied: {
                fulfillment,
                tracking,
                status: nextStatus,
                note,
            },
        });
    } catch (err) {
        logger.error(`updateEtsyOrderItemTracking error: ${err.message}`);
        return res.status(500).json({ ok: false, message: "Internal Server Error", error: err.message });
    }
};

const updateEtsyOrderTrackingForAllItems = async (req, res) => {
    try {
        const orderId = String(req.params.orderId || "").trim();
        const user = req.user;
        const body = req.body || {};
        const fulfillment = body.fulfillment !== undefined ? String(body.fulfillment).trim() : undefined;
        const tracking = body.tracking !== undefined ? String(body.tracking).trim() : undefined;
        const actualShipAt = normalizeEtsyActualShipAt(body.actualShipAt);
        const note = body.note !== undefined ? String(body.note) : undefined;
        const status = body.status !== undefined ? String(body.status).trim() : undefined;
        const noteTarget = String(body.transactionId || body.orderItemId || "").trim();
        const rawItemNotes = body.itemNotes || body.notesByTransactionId || body.notes;

        const noteUpdates = [];
        if (note !== undefined && noteTarget) {
            noteUpdates.push({ transactionId: noteTarget, note });
        }
        if (Array.isArray(rawItemNotes)) {
            for (const entry of rawItemNotes) {
                const transactionId = String(entry?.transactionId || entry?.orderItemId || "").trim();
                if (transactionId) {
                    noteUpdates.push({
                        transactionId,
                        note: entry?.note !== undefined ? String(entry.note) : "",
                    });
                }
            }
        } else if (rawItemNotes && typeof rawItemNotes === "object") {
            for (const [transactionId, itemNote] of Object.entries(rawItemNotes)) {
                const tx = String(transactionId || "").trim();
                if (tx) noteUpdates.push({ transactionId: tx, note: itemNote !== undefined ? String(itemNote) : "" });
            }
        }

        if (!orderId) return res.status(400).json({ message: "orderId is required" });
        if (body.actualShipAt !== undefined && !actualShipAt) {
            return res.status(400).json({ message: "actualShipAt must be a valid ISO date" });
        }
        if (status && !ETSY_TRACKING_STATUSES.includes(status)) {
            return res.status(400).json({
                message: "Invalid status",
                allowed: ETSY_TRACKING_STATUSES,
            });
        }

        if (note !== undefined && !noteTarget && noteUpdates.length === 0) {
            return res.status(400).json({
                message: "note must target a specific item. Provide transactionId/orderItemId, or use itemNotes.",
            });
        }

        if (
            fulfillment === undefined &&
            tracking === undefined &&
            status === undefined &&
            noteUpdates.length === 0 &&
            !actualShipAt
        ) {
            return res.status(400).json({
                message: "No updatable fields provided (fulfillment/tracking/status/itemNotes)",
            });
        }

        let nextStatus;
        if (isEtsyCanceledStatus(status)) {
            nextStatus = "Cancelled";
        } else if (tracking !== undefined && tracking.length > 0) {
            nextStatus = "Shipped";
        } else {
            nextStatus = status;
        }

        const beforeDoc = await EtsyOrder.findOne({ orderId }, { orderId: 1, status: 1 }).lean();
        if (!beforeDoc) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        const oldOrderStatus = beforeDoc.status;
        const set = {};
        if (fulfillment !== undefined) set["items.$[].tracking_info.fulfillment"] = fulfillment;
        if (tracking !== undefined) set["items.$[].tracking_info.tracking"] = tracking;
        if (actualShipAt) set["items.$[carrierPending].tracking_info.actualShipAt"] = actualShipAt;

        if (nextStatus !== undefined) {
            set["items.$[].tracking_info.status"] = nextStatus;
            if (["Fulfilled", "Shipping", "Shipped"].includes(nextStatus)) {
                set["items.$[].scale_status"] = "Complete";
                set.scale_overall_status = "Sent";
            } else if (isEtsyCanceledStatus(nextStatus)) {
                set["items.$[].scale_status"] = "Cancelled";
                set.scale_overall_status = "Cancelled";
            }
        }
        if (Object.keys(set).length > 0) {
            set["items.$[].tracking_info.updated_at"] = new Date();
        }

        let updated = Object.keys(set).length > 0
            ? await EtsyOrder.findOneAndUpdate(
                { orderId },
                { $set: set },
                {
                    new: true,
                    ...(actualShipAt
                        ? { arrayFilters: [{ "carrierPending.tracking_info.actualShipAt": null }] }
                        : {}),
                }
            )
            : await EtsyOrder.findOne({ orderId });

        if (!updated) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        const noteResults = [];
        for (const noteUpdate of noteUpdates) {
            const result = await EtsyOrder.updateOne(
                { _id: updated._id, "items.transactionId": noteUpdate.transactionId },
                {
                    $set: {
                        "items.$.tracking_info.note": noteUpdate.note,
                        "items.$.tracking_info.updated_at": new Date(),
                    },
                }
            );
            noteResults.push({
                transactionId: noteUpdate.transactionId,
                matched: result.matchedCount || 0,
                modified: result.modifiedCount || 0,
            });
        }

        if (noteUpdates.length > 0) {
            updated = await EtsyOrder.findById(updated._id);
        }

        const newOrderStatus = computeEtsyOrderStatusFromItems(updated.items || []);
        if (newOrderStatus !== updated.status) {
            await EtsyOrder.updateOne({ _id: updated._id }, { $set: { status: newOrderStatus } });
            updated.status = newOrderStatus;
        }

        if (oldOrderStatus !== newOrderStatus) {
            await logOrderHistory({
                orderDoc: updated,
                action: "UPDATE_STATUS",
                description: `Etsy order status changed from ${oldOrderStatus} to ${newOrderStatus}`,
                changes: [
                    {
                        field: "status",
                        from: oldOrderStatus,
                        to: newOrderStatus,
                    },
                ],
                user,
                context: {
                    source: "PORTAL",
                    ip: req.ip,
                    userAgent: req.headers["user-agent"],
                },
            });
            await logOrderLifecycleEvent(buildOrderLifecyclePayload({
                order: updated,
                req,
                fallbackPlatform: "etsy",
                stage: "ORDER_STATUS",
                eventType: "ORDER_STATUS_CHANGED",
                status: "success",
                message: `Etsy order status changed from ${oldOrderStatus} to ${newOrderStatus}`,
                metadata: { fromStatus: oldOrderStatus, toStatus: newOrderStatus },
            }));
        }

        const etsyUpload = await queueEtsyTrackingUpload({ req, order: beforeDoc, tracking });

        const responseScaleOverall =
            ["Fulfilled", "Shipping", "Shipped"].includes(nextStatus)
                ? "Sent"
                : isEtsyCanceledStatus(nextStatus)
                    ? "Cancelled"
                    : updated.scale_overall_status;

        return res.json({
            message: "Etsy tracking updated for ALL items (priority: Canceled/Cancelled > auto-Ship on tracking). Item & order statuses synced.",
            orderId: updated.orderId,
            orderStatus: newOrderStatus,
            scale_overall_status: responseScaleOverall,
            applied: {
                fulfillment,
                tracking,
                status: nextStatus,
                noteUpdates,
                noteResults,
            },
            etsyUpload,
        });
    } catch (err) {
        logger.error(`updateEtsyOrderTrackingForAllItems error: ${err.message}`);
        return res.status(500).json({ message: "Update failed", error: err.message });
    }
};

async function queueEtsyTrackingUpload({ req, order, tracking }) {
    const shopId = String(order?.shopId || "").trim();
    const trackingNumber = String(tracking || "").trim();
    if (!trackingNumber || trackingNumber === "-" || !/^[a-fA-F0-9]{24}$/.test(shopId)) {
        return { status: "skipped" };
    }

    const type = "ETSY_UPLOAD_TRACKING";
    const payload = {
        machineId: shopId,
        mongoShopId: shopId,
        shopId,
        orderId: order.orderId,
        trackingNumber,
    };
    const taskId = buildTaskId({ type, shopId, machineId: shopId, payload });
    const existing = await ExtensionTask.findOne({ taskId }, { status: 1 }).lean();
    if (["sent", "received", "completed"].includes(existing?.status)) {
        return { status: existing.status, taskId };
    }

    const io = req.app?.get?.("io");
    if (!io) {
        logger.error("Etsy tracking task was not queued: Socket.IO unavailable");
        return { status: "unavailable", taskId };
    }

    await emitTaskToMachine(io, { taskId, type, shopId, machineId: shopId, payload });
    return { status: "queued", taskId };
}

function normalizeEtsyActualShipAt(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

const ETSY_SCALE_KNOWN = [
    "Need Scale",
    "Pending",
    "Ready",
    "Sent",
    "Failed",
    "QC Rejected",
    "Cancelled",
    "Address Invalid",
];

const ETSY_SCALE_ACTIVE = ["Need Scale", "Pending", "Sent", "QC Rejected"];
const ETSY_QC_ACTIVE = ["Pending", "Sent", "QC Rejected", "Ready", "Failed", "Address Invalid"];

const hasRole = (userRole, target) => {
    if (!userRole) return false;
    const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
    const wanted = normalize(target);
    if (Array.isArray(userRole)) return userRole.some((role) => normalize(role) === wanted);
    if (typeof userRole === "object" && Array.isArray(userRole.roles)) {
        return userRole.roles.some((role) => normalize(role) === wanted);
    }
    return normalize(userRole) === wanted;
};

const canonScaleStatus = (value) => {
    const status = String(value || "").trim();
    if (!status) return "";
    if (/^complete$/i.test(status)) return "Ready";
    if (/^qc\s*reject(?:ed)?$/i.test(status)) return "QC Rejected";
    if (/^addr(?:ess)?\s*invalid$/i.test(status)) return "Address Invalid";
    return status;
};

const buildScaleOverallMatch = (statuses = []) => {
    const values = [...new Set(statuses.filter(Boolean))];
    if (values.includes("Need Scale")) values.push(null);
    return { $in: values };
};

function computeEtsyOverallScaleStatus(items = []) {
    if (!Array.isArray(items) || items.length === 0) return "Need Scale";
    const statuses = items.map((item) => String(item?.scale_status || "Need Scale"));
    if (statuses.some((status) => status === "QC Rejected")) return "QC Rejected";
    if (statuses.every((status) => status === "Complete")) return "Ready";
    if (statuses.every((status) => status === "Pending" || status === "Complete")) return "Pending";
    return "Need Scale";
}

const toPlainFulfillmentFile = (value) => {
    if (!value) return {};
    if (value instanceof Map) return Object.fromEntries(value);
    if (typeof value === "object" && !Array.isArray(value)) return toPlainObject(value);
    if (typeof value === "string") return { file: value };
    return {};
};

const toPlainObject = (value) => {
    if (!value) return value;
    if (value instanceof Map) return Object.fromEntries(value);
    if (typeof value?.toObject === "function") {
        return value.toObject({ depopulate: false, flattenMaps: true, virtuals: false });
    }
    if (Array.isArray(value)) return value.map(toPlainObject);
    if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, objectValue]) => [key, toPlainObject(objectValue)]));
    }
    return value;
};

const hasAnyFulfillmentFile = (value) => Object.values(toPlainFulfillmentFile(value)).some(Boolean);

const buildEtsyVendorFailure = (order) => {
    const submissions = order?.vendor_submissions || {};
    for (const [provider, submission] of Object.entries(submissions)) {
        if (!submission || submission.sent === true) continue;
        const response = submission.last_response || {};
        const error = response.error || response.message || "";
        if (!error) continue;
        return {
            provider,
            error,
            attempt_count: submission.attempt_count || 0,
            at: response.at || submission.sent_at || null,
        };
    }

    const grabink = order?.grabink_submission;
    if (grabink?.sent === false && grabink?.last_response?.error) {
        return {
            provider: "grabink",
            error: grabink.last_response.error,
            attempt_count: grabink.attempt_count || 0,
            at: grabink.last_response.at || grabink.sent_at || null,
        };
    }

    return null;
};

const normalizeOrderIds = (rawOrderIds) => {
    if (!Array.isArray(rawOrderIds) || rawOrderIds.length === 0) return null;
    return [
        ...new Set(
            rawOrderIds
                .map((orderId) => (typeof orderId === "string" ? orderId.trim() : String(orderId || "").trim()))
                .filter(Boolean)
        ),
    ];
};

const buildFulfillmentPlatformUrl = (baseUrl) =>
    `${String(baseUrl || "").replace(/\/+$/, "")}/api/portal/orders`;

const toSafeFulfillmentSummary = (data, fallbackSuccess = true) => {
    const source = data && typeof data === "object" ? data : {};
    const numberOrZero = (value) => {
        const num = Number(value);
        return Number.isFinite(num) ? num : 0;
    };
    const errors = Array.isArray(source.errors)
        ? source.errors.map((error) => {
            if (typeof error === "string") return { message: error };
            if (!error || typeof error !== "object") return { message: String(error) };
            return {
                orderId: error.orderId,
                field: error.field,
                code: error.code,
                message: error.message || error.error,
            };
        })
        : [];
    const orders = Array.isArray(source.orders)
        ? source.orders.map((order) => {
            if (typeof order === "string") return { orderId: order };
            if (!order || typeof order !== "object") return { orderId: String(order) };
            return {
                orderId: order.orderId,
                status: order.status,
                action: order.action,
                skipped: order.skipped,
                message: order.message,
            };
        })
        : [];

    return {
        success: typeof source.success === "boolean" ? source.success : Boolean(fallbackSuccess),
        received: numberOrZero(source.received),
        inserted: numberOrZero(source.inserted),
        updated: numberOrZero(source.updated),
        skipped: numberOrZero(source.skipped),
        errorsCount: source.errorsCount !== undefined ? numberOrZero(source.errorsCount) : errors.length,
        errors,
        orders,
    };
};

const pushVersion3Entry = (entries, label, value) => {
    const normalizedLabel = String(label || "").trim();
    if (!normalizedLabel) return;
    entries.push({
        label: normalizedLabel,
        value: value === undefined || value === null ? "" : String(value),
    });
};

const buildEtsyVersion3Data = (item = {}) => {
    const entries = [];

    if (Array.isArray(item.version3Data)) {
        item.version3Data.forEach((entry) => {
            pushVersion3Entry(entries, entry?.label || entry?.name, entry?.value);
        });
    }

    if (item.variations && typeof item.variations === "object" && !Array.isArray(item.variations)) {
        Object.entries(item.variations).forEach(([label, value]) => {
            pushVersion3Entry(entries, label, value);
        });
    }

    const customizations = item.customizations || {};
    if (Array.isArray(customizations.textFields)) {
        customizations.textFields.forEach((field) => {
            pushVersion3Entry(entries, field?.name || field?.label || "Customization", field?.value);
        });
    }
    if (customizations.buyerNote) {
        pushVersion3Entry(entries, "Buyer Note", customizations.buyerNote);
    }

    const seen = new Set();
    return entries.filter((entry) => {
        const key = `${entry.label}::${entry.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const getFulfillmentFileKeys = (value) => {
    const fileMap = toPlainFulfillmentFile(value);
    return Object.keys(fileMap).filter((key) => fileMap[key]);
};

const hasEtsyProductionFile = (item) =>
    Boolean(item?.svgFile) || getFulfillmentFileKeys(item?.fulfillment_file || item?.fulfillmentFile).length > 0;

const withEtsyProductionVendorOverride = (costBreakdown) => {
    const costCenter = toPlainObject(costBreakdown);
    if (costCenter.vendorProductId) return costCenter;
    return {
        ...costCenter,
        vendorKey: "lng",
        vendor_mapping_override: true,
        vendor_mapping_override_reason: "missing portal vendor mapping",
    };
};

const getEtsyProductionPrerequisiteErrors = (order) =>
    (Array.isArray(order?.items) ? order.items : []).flatMap((item) => {
        const errors = [];
        const itemId = item?.transactionId || item?.orderItemId || "";
        if (!hasEtsyProductionFile(item)) {
            errors.push({ itemId, code: "MISSING_FULFILLMENT_FILE", message: "Missing fulfillment file" });
        }
        return errors;
    });

const toEtsyFullSizeImageUrl = (url) => {
    const value = firstNonBlankString(url);
    if (!value) return "";
    return value.replace(/\/il_(?:\d+x\d+|\d+xN|N+x\d+)\./i, "/il_fullxfull.");
};

const normalizeEtsyImageLinks = (value) => {
    if (value instanceof Map || typeof value?.toObject === "function") {
        return normalizeEtsyImageLinks(toPlainObject(value));
    }
    if (typeof value === "string") return toEtsyFullSizeImageUrl(value);
    if (Array.isArray(value)) return value.map(normalizeEtsyImageLinks);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, objectValue]) => [
                key,
                normalizeEtsyImageLinks(objectValue),
            ])
        );
    }
    return value;
};

const buildFulfillmentPlatformPayloadPreview = (payload) =>
    (Array.isArray(payload?.data) ? payload.data : []).flatMap((order) =>
        (Array.isArray(order.items) ? order.items : []).map((item) => ({
            orderId: order.orderId,
            itemId: item.orderItemId || item.transactionId || "",
            sku: item.sku || "",
            hasSnapshotImage: Boolean(item.snapshotImageUrl || item.snapshotImage),
            hasBaseImageUrl: Boolean(item.baseImageUrl),
            fulfillmentFileKeys: getFulfillmentFileKeys(item.fulfillment_file || item.fulfillmentFile),
        }))
    );

const resolveEtsyBaseImageUrl = (item = {}) => {
    if (typeof item.baseImage === "string") return toEtsyFullSizeImageUrl(item.baseImage);

    return toEtsyFullSizeImageUrl(firstNonBlankString(
        item.baseImageUrl,
        item.baseImage?.imageUrl,
        item.baseImage?.url,
        item.baseImage?.src,
        item.baseImage?.previewUrl,
        item.listing?.product_image,
        item.listing?.imageUrl
    ));
};

const serializeEtsyOrderForFulfillmentPlatform = (order) => ({
    orderId: order.orderId,
    customer_infor: {
        email: order.buyer?.email || "",
        name: order.buyer?.fullName || order.shipping?.name || "",
        address: order.shipping?.address1 || "",
        address_2: order.shipping?.address2 || "",
        city: order.shipping?.city || "",
        state: order.shipping?.state || "",
        zip_code: order.shipping?.zipcode || "",
        country: order.shipping?.country || "US",
        phone_number: order.shipping?.phone || "",
    },
    status: "Fulfilled",
    purchase_date: order.saleDate ? new Date(order.saleDate).toISOString() : null,
    shopId: order.shopId ? String(order.shopId?._id || order.shopId) : "",
    shopName: order.shopId?.name || order.shopName || "",
    shipping_type: order.shipping_type || "Standard",
    items: (order.items || []).map((item) => {
        const snapshotImageUrl = toEtsyFullSizeImageUrl(item.snapshotImageUrl || item.snapshotImage || "");
        const baseImageUrl = resolveEtsyBaseImageUrl(item);

        return {
            orderItemId: item.transactionId || item.orderItemId || "",
            transactionId: item.transactionId || "",
            sku: item.sku || "",
            title: item.itemName || item.title || "",
            quantity: item.quantity || 1,
            asin: item.asin || "",
            version3Data: buildEtsyVersion3Data(item),
            customized_url: toEtsyFullSizeImageUrl(item.customized_url),
            baseImageUrl,
            snapshotImage: snapshotImageUrl,
            snapshotImageUrl,
            fulfillment_file: normalizeEtsyImageLinks(toPlainFulfillmentFile(item.fulfillment_file)),
            listingId: item.listingId || "",
            cost_center: withEtsyProductionVendorOverride(item.cost_breakdown),
            scale_status: item.scale_status || null,
            qc_note: item.qc_note || "",
            cs_note: item.cs_note || "",
            customizations: toPlainObject(item.customizations) || null,
            customFiles: normalizeEtsyImageLinks(item.customFiles || []),
        };
    }),
    source: "portal",
    sourceChannel: "ETSY",
});

const recordEtsyFulfillmentPlatformV2Failure = async (orders, fulfillment, req = null) => {
    await Promise.all(
        (orders || []).map(async (order) => {
            const prevSubmission = order.fulfillment_platform_v2_submission || {};
            const attemptCount = (prevSubmission.attempt_count || 0) + 1;
            order.fulfillment_platform_v2_submission = {
                sent: false,
                sent_at: prevSubmission.sent_at || null,
                attempt_count: attemptCount,
                last_response: fulfillment,
                sourceChannel: "ETSY",
            };
            await order.save();
            await logOrderLifecycleEvent(buildOrderLifecyclePayload({
                order,
                req,
                fallbackPlatform: "etsy",
                stage: "VENDOR_PUSH",
                eventType: "VENDOR_PUSH_FAILED",
                status: "failed",
                reason: "Failed to push Etsy orders to Fulfillment Platform",
                metadata: {
                    provider: "fulfillment-platform-v2",
                    attemptCount,
                    sourceChannel: "ETSY",
                },
            }));
        })
    );
};

const recordEtsyFulfillmentPlatformV2Success = async ({ orders, fulfillment, req }) => {
    const fulfilledAt = new Date();

    await Promise.all(
        (orders || []).map(async (order) => {
            const prevOverallStatus = order.scale_overall_status;
            const prevOrderStatus = order.status;
            const prevSubmission = order.fulfillment_platform_v2_submission || {};
            const attemptCount = (prevSubmission.attempt_count || 0) + 1;

            order.fulfillment_platform_v2_submission = {
                sent: true,
                sent_at: fulfilledAt,
                attempt_count: attemptCount,
                last_response: fulfillment,
                sourceChannel: "ETSY",
            };
            order.scale_overall_status = "Sent";
            order.status = "Fulfilled";
            order.fulfilled_at = fulfilledAt;

            for (const item of order.items || []) {
                item.tracking_info = item.tracking_info || {};
                if (
                    item.tracking_info.status !== "Shipped" &&
                    !isEtsyCanceledStatus(item.tracking_info.status)
                ) {
                    item.tracking_info.status = "Fulfilled";
                }
                item.tracking_info.updated_at = fulfilledAt;
            }
            order.markModified("items");

            await order.save();

            await logOrderHistory({
                orderDoc: order,
                action: "PUSH_TO_FULFILLMENT_PLATFORM_V2",
                description: "Etsy order pushed to Fulfillment Platform v2.",
                changes: [
                    { field: "scale_overall_status", from: prevOverallStatus, to: "Sent" },
                    { field: "status", from: prevOrderStatus, to: "Fulfilled" },
                    {
                        field: "fulfillment_platform_v2_submission.sent",
                        from: !!prevSubmission.sent,
                        to: true,
                    },
                ],
                user: req.user,
                context: {
                    source: "SYSTEM",
                    ip: req.ip,
                    userAgent: req.headers["user-agent"],
                },
            });
            await logOrderLifecycleEvent(buildOrderLifecyclePayload({
                order,
                req,
                fallbackPlatform: "etsy",
                stage: "VENDOR_PUSH",
                eventType: "VENDOR_PUSH_SUCCESS",
                status: "success",
                message: "Etsy order pushed to Fulfillment Platform v2.",
                metadata: {
                    provider: "fulfillment-platform-v2",
                    attemptCount,
                    alreadySent: false,
                    sourceChannel: "ETSY",
                },
            }));
        })
    );
};

const pushEtsyOrdersToFulfillmentPlatformV2 = async ({ orders, req }) => {
    const apiBaseUrl = String(process.env.FULFILLMENT_API_BASE_URL || "").trim();
    const tenantApiKey = String(process.env.FULFILLMENT_TENANT_API_KEY || "").trim();
    const timeoutMs = Number(process.env.FULFILLMENT_API_TIMEOUT_MS || 30000);

    if (!apiBaseUrl || !tenantApiKey) {
        const err = new Error("Fulfillment Platform configuration is missing");
        err.status = 500;
        throw err;
    }

    const payload = { data: orders.map(serializeEtsyOrderForFulfillmentPlatform) };
    const payloadErrors = [];
    payload.data.forEach((order, orderIndex) => {
        if (!String(order.orderId || "").trim()) {
            payloadErrors.push({
                field: `data[${orderIndex}].orderId`,
                message: "orderId is required",
            });
        }
        order.items.forEach((item, itemIndex) => {
            if (!String(item.orderItemId || "").trim()) {
                payloadErrors.push({
                    field: `data[${orderIndex}].items[${itemIndex}].orderItemId`,
                    message: "orderItemId is required",
                });
            }
        });
    });
    if (payloadErrors.length > 0) {
        const err = new Error("Invalid Fulfillment Platform v2 payload");
        err.status = 400;
        err.errors = payloadErrors;
        throw err;
    }

    logger.debug({
        tag: "EtsyQC.pushPlatformOrders.preview",
        payload: buildFulfillmentPlatformPayloadPreview(payload),
    });

    try {
        const platformResponse = await axios.post(
            buildFulfillmentPlatformUrl(apiBaseUrl),
            payload,
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${tenantApiKey}`,
                },
                timeout: Number.isFinite(timeoutMs) ? timeoutMs : 30000,
            }
        );

        const fulfillment = toSafeFulfillmentSummary(platformResponse?.data, true);
        await recordEtsyFulfillmentPlatformV2Success({ orders, fulfillment, req });
        return { fulfillment };
    } catch (err) {
        const fulfillment = err.response
            ? toSafeFulfillmentSummary(err.response.data, false)
            : toSafeFulfillmentSummary(
                {
                    success: false,
                    errorsCount: 1,
                    errors: [{ message: err.message || "Fulfillment Platform request failed" }],
                },
                false
            );

        await recordEtsyFulfillmentPlatformV2Failure(orders, fulfillment, req);

        const wrapped = new Error("Failed to push Etsy orders to Fulfillment Platform");
        wrapped.status = err.response?.status || err.status || 502;
        wrapped.fulfillment = fulfillment;
        wrapped.errors = err.errors;
        throw wrapped;
    }
};

const getRequester = (req) => ({
    userId: req.user?.userId || req.user?.id || req.user?._id || "",
    role: req.user?.role,
});

const isSellerOnlyUser = (role) =>
    hasRole(role, "Seller") &&
    !(hasRole(role, "Admin") || hasRole(role, "Customer Service") || hasRole(role, "Design Leader"));

const getEtsyCustomerInfo = (order) => ({
    email: order.customer_infor?.email || "",
    name: order.customer_infor?.name || order.shipping?.name || order.buyer?.fullName || order.buyer?.display || "",
    address: order.customer_infor?.address || order.shipping?.address1 || "",
    address_2: order.customer_infor?.address_2 || order.shipping?.address2 || "",
    province: order.customer_infor?.province || order.shipping?.state || "",
    city: order.customer_infor?.city || order.shipping?.city || "",
    state: order.customer_infor?.state || order.shipping?.state || "",
    zip_code: order.customer_infor?.zip_code || order.shipping?.zipcode || "",
    country: order.customer_infor?.country || order.shipping?.country || "US",
    phone_number: order.customer_infor?.phone_number || "",
});

const prepareEtsyOrderForFulfillment = (order) => {
    order.customer_infor = getEtsyCustomerInfo(order);
    for (const item of order.items || []) {
        if (!item.orderItemId) item.orderItemId = item.transactionId;
        if (!item.title) item.title = item.itemName || item.sku || "";
    }
    order.markModified("items");
    return order;
};

const buildEtsyOrderLookup = (req) => {
    const orderId = String(req.params.orderId || req.body?.orderId || "").trim();
    const shopId = String(req.query.shopId || req.body?.shopId || "").trim();
    const query = { orderId };
    if (shopId && mongoose.Types.ObjectId.isValid(shopId)) query.shopId = new mongoose.Types.ObjectId(shopId);
    return query;
};

const ensureSellerCanAccessEtsyOrder = (req, order) => {
    const { userId, role } = getRequester(req);
    if (!isSellerOnlyUser(role)) return null;
    if (!mongoose.Types.ObjectId.isValid(userId)) return "Invalid user id in token";
    if (String(order?.seller?.sellerId || "") !== String(userId)) {
        return "You can only access your own Etsy orders";
    }
    return null;
};

function normalizeEtsyProviderKey(vendorDoc) {
    const ft = String(vendorDoc?.fulfillment_type || "").toLowerCase();
    const nm = String(vendorDoc?.name || "").toLowerCase();

    if (ft.includes("merchfox") || nm.includes("merchfox")) return "merchfox";
    if (ft.includes("grabink") || nm.includes("grabink")) return "grabink";
    if (ft.includes("merchize") || nm.includes("merchize")) return "merchize";
    if (ft.includes("printway") || nm.includes("printway")) return "printway";
    if (ft.includes("mangotee") || nm.includes("mangotee")) return "mangotee";
    if (ft.includes("ss88") || nm.includes("ss88")) return "ss88";
    if (ft.includes("lenful") || nm.includes("lenful")) return "lenful";
    if (ft.includes("pgprint") || nm.includes("pgprint")) return "pgprint";
    if (ft.includes("luxurypro") || nm.includes("luxurypro")) return "luxurypro";
    if (ft.includes("luxury pro") || nm.includes("luxury pro")) return "luxurypro";
    if (ft.includes("onos") || nm.includes("onos")) return "onos";
    if (ft.includes("lng") || nm.includes("lng")) return "lng";
    return null;
}

async function resolveEtsyProviderFromOrder(orderDoc) {
    const idObjs = [];
    for (const item of orderDoc.items || []) {
        const raw = item?.cost_breakdown?.vendorProductId;
        if (!raw) continue;
        const id = String(raw);
        if (mongoose.Types.ObjectId.isValid(id)) {
            idObjs.push(new mongoose.Types.ObjectId(id));
        }
    }

    if (idObjs.length === 0) {
        return { providerKey: null, reasons: ["No valid vendorProductId found on items"] };
    }

    const vendorProducts = await db.vendorProduct.find({ _id: { $in: idObjs } })
        .select("vendor_id")
        .populate({ path: "vendor_id", select: "name fulfillment_type status" })
        .lean();

    if (!vendorProducts?.length) {
        return { providerKey: null, reasons: ["No VendorProduct matched in DB"] };
    }

    const providerSet = new Set();
    for (const vendorProduct of vendorProducts) {
        const key = normalizeEtsyProviderKey(vendorProduct?.vendor_id);
        if (key) providerSet.add(key);
    }

    if (providerSet.size > 1) {
        const providers = [...providerSet];
        const err = new Error(`Multiple providers detected in order: ${providers.join(", ")}`);
        err.status = 409;
        err.code = "MULTIPLE_VENDORS_IN_ORDER";
        err.providers = providers;
        throw err;
    }

    if (providerSet.size === 0) {
        return { providerKey: null, reasons: ["Vendor present but cannot map to a provider"] };
    }

    return { providerKey: [...providerSet][0], reasons: [] };
}

const isEtsyAddressInvalid = (order) =>
    order?.address_validation && order.address_validation.isValid === false;

const buildEtsyInvalidAddressMessage = (order) => {
    const customer = getEtsyCustomerInfo(order);
    const addr = [
        customer.name,
        customer.address,
        customer.address_2,
        `${customer.city || ""}${customer.state ? ", " + customer.state : ""} ${customer.zip_code || ""}`,
        customer.country,
    ].filter(Boolean).join(" | ");

    return `Invalid Address: address validation failed. Please correct the address before sending. Address: ${addr}`;
};

async function sendEtsyOrderToVendor({ order, provider, req, previousOverallStatus }) {
    const availableProviders = (FulfillmentService.PROVIDERS || []).map((entry) => entry.key);
    const providersHint = availableProviders.length
        ? availableProviders.join(" | ")
        : "grabink | merchfox | merchize | printway | mangotee | lng | lenful | ss88 | pgprint";

    let providerKey = String(provider || "").trim().toLowerCase();
    if (!providerKey) {
        try {
            const resolved = await resolveEtsyProviderFromOrder(order);
            providerKey = resolved.providerKey || "";
        } catch (err) {
            err.hint = `Please specify "provider" in query/body, e.g., ?provider=${providersHint}`;
            throw err;
        }
    }

    if (!providerKey) {
        const err = new Error("Unable to determine provider automatically.");
        err.status = 409;
        err.hint = `Please specify "provider" in query/body, e.g., ?provider=${providersHint}`;
        throw err;
    }

    if (availableProviders.length && !availableProviders.includes(providerKey)) {
        const err = new Error(`Unknown provider: ${providerKey}`);
        err.status = 400;
        err.hint = `Valid providers: ${providersHint}`;
        throw err;
    }

    prepareEtsyOrderForFulfillment(order);

    try {
        const result = await FulfillmentService.send(order, providerKey, { sourceChannel: "ETSY" });
        await logOrderHistory({
            orderDoc: order,
            action: "SEND_TO_VENDOR",
            description: result.alreadySent
                ? `Etsy order already sent to ${result.vendorKey}.`
                : `Etsy order sent to ${result.vendorKey}.`,
            changes: [{ field: "vendor", from: null, to: result.vendorKey }],
            user: req.user,
            context: {
                source: "SYSTEM",
                ip: req.ip,
                userAgent: req.headers["user-agent"],
            },
        });
        await logOrderLifecycleEvent(buildOrderLifecyclePayload({
            order,
            req,
            fallbackPlatform: "etsy",
            stage: "VENDOR_PUSH",
            eventType: result.alreadySent ? "VENDOR_PUSH_SKIPPED" : "VENDOR_PUSH_SUCCESS",
            status: result.alreadySent ? "info" : "success",
            message: result.alreadySent
                ? `Etsy order already sent to ${result.vendorKey}.`
                : `Etsy order sent to ${result.vendorKey}.`,
            metadata: {
                provider: result.vendorKey,
                alreadySent: !!result.alreadySent,
            },
        }));
        return result;
    } catch (err) {
        const prev = order.vendor_submissions?.[providerKey] || {};
        const rec = {
            ...(prev || {}),
            sent: false,
            attempt_count: (prev?.attempt_count || 0) + 1,
            last_response: { error: err.message, vendorResponse: err.vendorResponse || null, at: new Date() },
        };

        order.vendor_submissions = order.vendor_submissions || {};
        order.vendor_submissions[providerKey] = rec;
        order.markModified("vendor_submissions");
        if (providerKey === "grabink") order.grabink_submission = rec;
        order.scale_overall_status = "Failed";
        await order.save();

        await logOrderHistory({
            orderDoc: order,
            action: "SEND_TO_VENDOR_FAILED",
            description: `Sending Etsy order to ${providerKey} failed. Overall status set to Failed.`,
            changes: [
                { field: "scale_overall_status", from: previousOverallStatus, to: "Failed" },
                {
                    field: `vendor_submissions.${providerKey}.attempt_count`,
                    from: prev?.attempt_count || 0,
                    to: rec.attempt_count,
                },
                {
                    field: `vendor_submissions.${providerKey}.last_response.error`,
                    from: null,
                    to: err.message,
                },
            ],
            user: req.user,
            context: {
                source: "SYSTEM",
                ip: req.ip,
                userAgent: req.headers["user-agent"],
            },
        });
        await logOrderLifecycleEvent(buildOrderLifecyclePayload({
            order,
            req,
            fallbackPlatform: "etsy",
            stage: "VENDOR_PUSH",
            eventType: "VENDOR_PUSH_FAILED",
            status: "failed",
            reason: err.message,
            metadata: {
                provider: providerKey,
                attemptCount: rec.attempt_count,
            },
        }));

        err.status = err.status || 502;
        err.providerKey = providerKey;
        throw err;
    }
}

async function sendEtsyReadyOrderAfterQc({ order, req }) {
    const resolved = await resolveEtsyProviderFromOrder(order);
    const providerKey = resolved.providerKey || "";

    if (providerKey === "lng") {
        const result = await pushEtsyOrdersToFulfillmentPlatformV2({
            orders: [order],
            req,
        });
        return { mode: "platform", fulfillment: result.fulfillment };
    }

    const result = await sendEtsyOrderToVendor({
        order,
        provider: providerKey,
        req,
        previousOverallStatus: "Ready",
    });
    return { mode: "vendor", ...result };
}

const buildEtsyScalePipeline = (req, activeStatuses, options = {}) => {
    const {
        from,
        to,
        scale_status,
        search,
        shopName,
        cs_unassigned = "",
        cs_assignee_id = "",
        cs_assignment_status = "",
        sellerId,
        vendor,
        failureReason,
        orderStatus,
        scaleBy,
        qcBy,
        hasScaleFile,
    } = req.query;

    const { userId, role } = getRequester(req);
    const isSellerOnly = isSellerOnlyUser(role);
    const isCS = hasRole(role, "Customer Service");
    const restrictCsToAssigned = options.restrictCsToAssigned === true;

    const matchStage = {};
    let onlyPending = false;
    if (orderStatus && String(orderStatus).trim() && !/^all$/i.test(String(orderStatus).trim())) {
        matchStage.status = String(orderStatus).trim();
    } else {
        matchStage.status = { $nin: ["Canceled", "Cancelled"] };
    }
    if (from && to) matchStage.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    if (isSellerOnly && mongoose.Types.ObjectId.isValid(userId)) {
        matchStage["seller.sellerId"] = new mongoose.Types.ObjectId(userId);
    }
    if (scaleBy && mongoose.Types.ObjectId.isValid(scaleBy)) {
        matchStage.scaleId = new mongoose.Types.ObjectId(scaleBy);
    }
    if (restrictCsToAssigned && isCS && mongoose.Types.ObjectId.isValid(userId)) {
        matchStage.csAssigneeId = new mongoose.Types.ObjectId(userId);
    }
    if (!isSellerOnly && sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
        matchStage["seller.sellerId"] = new mongoose.Types.ObjectId(sellerId);
    }
    const qcAssigneeId = qcBy || cs_assignee_id;
    if (qcAssigneeId && mongoose.Types.ObjectId.isValid(qcAssigneeId)) {
        matchStage.csAssigneeId = new mongoose.Types.ObjectId(qcAssigneeId);
    }
    if (cs_assignment_status && String(cs_assignment_status).trim()) {
        matchStage.cs_assignment_status = String(cs_assignment_status).trim();
    }
    if (String(cs_unassigned || "").toLowerCase() === "true") {
        matchStage.$or = [
            { csAssigneeId: { $exists: false } },
            { csAssigneeId: null },
            { cs_assignment_status: "Unassigned" },
        ];
    }
    if (scale_status && String(scale_status).trim()) {
        if (/^all$/i.test(String(scale_status).trim())) {
            matchStage.scale_overall_status = buildScaleOverallMatch(activeStatuses);
        } else {
            const wanted = String(scale_status).split(",").map(canonScaleStatus).filter(Boolean);
            const valid = wanted.filter((status) => ETSY_SCALE_KNOWN.includes(status));
            matchStage.scale_overall_status = buildScaleOverallMatch(valid.length ? valid : ["__NO_MATCH__"]);
            onlyPending = valid.length === 1 && valid[0] === "Pending";
        }
    } else {
        matchStage.scale_overall_status = buildScaleOverallMatch(activeStatuses);
    }
    if (onlyPending) {
        matchStage["items.scale_status"] = "Pending";
    }
    let broadSearchRegex = null;
    if (search && search.trim()) {
        const keyword = String(search).trim();
        if (/^\d{5,}$/.test(keyword)) {
            matchStage.orderId = keyword;
        } else {
            broadSearchRegex = new RegExp(escapeRegExp(keyword), "i");
        }
    }

    const pipeline = [
        { $match: matchStage },
        {
            $lookup: {
                from: "shops",
                localField: "shopId",
                foreignField: "_id",
                as: "shop",
            },
        },
        { $unwind: { path: "$shop", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "users",
                localField: "seller.sellerId",
                foreignField: "_id",
                as: "sellerUser",
            },
        },
        { $unwind: { path: "$sellerUser", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "users",
                localField: "scaleId",
                foreignField: "_id",
                as: "scaledBy",
            },
        },
        { $unwind: { path: "$scaledBy", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "users",
                localField: "csAssigneeId",
                foreignField: "_id",
                as: "cs_assignee",
            },
        },
        { $unwind: { path: "$cs_assignee", preserveNullAndEmptyArrays: true } },
        ...(shopName && shopName.trim()
            ? [{
                $match: {
                    $or: [
                        { "shop.name": { $regex: new RegExp(escapeRegExp(shopName.trim()), "i") } },
                        { "shop.store": { $regex: new RegExp(escapeRegExp(shopName.trim()), "i") } },
                    ],
                },
            }]
            : []),
    ];

    if (broadSearchRegex) {
        pipeline.push(
            {
                $addFields: {
                    searchVendorProductObjectIds: {
                        $filter: {
                            input: {
                                $map: {
                                    input: { $ifNull: ["$items", []] },
                                    as: "it",
                                    in: {
                                        $convert: {
                                            input: "$$it.cost_breakdown.vendorProductId",
                                            to: "objectId",
                                            onError: null,
                                            onNull: null,
                                        },
                                    },
                                },
                            },
                            as: "id",
                            cond: { $ne: ["$$id", null] },
                        },
                    },
                },
            },
            {
                $lookup: {
                    from: "vendorproducts",
                    localField: "searchVendorProductObjectIds",
                    foreignField: "_id",
                    as: "itemVendorProducts",
                },
            },
            {
                $lookup: {
                    from: "vendors",
                    localField: "itemVendorProducts.vendor_id",
                    foreignField: "_id",
                    as: "itemVendors",
                },
            }
        );
        pipeline.push({
            $match: {
                $or: [
                    { orderId: broadSearchRegex },
                    { "shop.name": broadSearchRegex },
                    { "shop.store": broadSearchRegex },
                    { "status": broadSearchRegex },
                    { "shipping_type": broadSearchRegex },
                    { "scale_overall_status": broadSearchRegex },
                    { "items.sku": broadSearchRegex },
                    { "items.orderItemId": broadSearchRegex },
                    { "items.transactionId": broadSearchRegex },
                    { "items.listingId": broadSearchRegex },
                    { "items.title": broadSearchRegex },
                    { "items.itemName": broadSearchRegex },
                    { "items.variationsRaw": broadSearchRegex },
                    { "items.customized_url": broadSearchRegex },
                    { "items.asin": broadSearchRegex },
                    { "items.cost_breakdown.sizeValue": broadSearchRegex },
                    { "items.cost_breakdown.colorValue": broadSearchRegex },
                    { "items.cost_breakdown.matchedSku": broadSearchRegex },
                    { "items.tracking_info.fulfillment": broadSearchRegex },
                    { "items.tracking_info.tracking": broadSearchRegex },
                    { "items.tracking_info.status": broadSearchRegex },
                    { "items.tracking_info.note": broadSearchRegex },
                    { "items.qc_note": broadSearchRegex },
                    { "items.cs_note": broadSearchRegex },
                    { "items.customizations.buyerNote": broadSearchRegex },
                    { "items.customizations.textFields.name": broadSearchRegex },
                    { "items.customizations.textFields.value": broadSearchRegex },
                    { "items.customFiles.fileName": broadSearchRegex },
                    { "items.customFiles.etsyFileId": broadSearchRegex },
                    { "items.customFiles.listingId": broadSearchRegex },
                    { "items.customFiles.status": broadSearchRegex },
                    { "items.customFiles.errorMessage": broadSearchRegex },
                    { "buyer.fullName": broadSearchRegex },
                    { "buyer.firstName": broadSearchRegex },
                    { "buyer.lastName": broadSearchRegex },
                    { "buyer.userId": broadSearchRegex },
                    { "buyer.display": broadSearchRegex },
                    { "shipping.name": broadSearchRegex },
                    { "shipping.address1": broadSearchRegex },
                    { "shipping.address2": broadSearchRegex },
                    { "shipping.city": broadSearchRegex },
                    { "shipping.state": broadSearchRegex },
                    { "shipping.zipcode": broadSearchRegex },
                    { "shipping.country": broadSearchRegex },
                    { "seller.sellerCode": broadSearchRegex },
                    { "sellerUser.full_name": broadSearchRegex },
                    { "sellerUser.email": broadSearchRegex },
                    { "scaledBy.full_name": broadSearchRegex },
                    { "scaledBy.email": broadSearchRegex },
                    { "cs_assignee.full_name": broadSearchRegex },
                    { "cs_assignee.email": broadSearchRegex },
                    { "itemVendorProducts.product_name": broadSearchRegex },
                    { "itemVendorProducts.product_id": broadSearchRegex },
                    { "itemVendors.name": broadSearchRegex },
                    { "itemVendors.fulfillment_type": broadSearchRegex },
                ],
            },
        });
    }

    if (vendor && String(vendor).trim()) {
        const vendorPattern = escapeRegExp(String(vendor).trim());
        pipeline.push(
            {
                $addFields: {
                    vendorProductObjectIds: {
                        $filter: {
                            input: {
                                $map: {
                                    input: { $ifNull: ["$items", []] },
                                    as: "it",
                                    in: {
                                        $convert: {
                                            input: "$$it.cost_breakdown.vendorProductId",
                                            to: "objectId",
                                            onError: null,
                                            onNull: null,
                                        },
                                    },
                                },
                            },
                            as: "id",
                            cond: { $ne: ["$$id", null] },
                        },
                    },
                },
            },
            {
                $lookup: {
                    from: "vendorproducts",
                    localField: "vendorProductObjectIds",
                    foreignField: "_id",
                    as: "itemVendorProducts",
                },
            },
            {
                $lookup: {
                    from: "vendors",
                    localField: "itemVendorProducts.vendor_id",
                    foreignField: "_id",
                    as: "itemVendors",
                },
            },
            {
                $lookup: {
                    from: "vendors",
                    localField: "forced_vendor_id",
                    foreignField: "_id",
                    as: "forcedVendor",
                },
            },
            {
                $addFields: {
                    vendor_filter_values: {
                        $setUnion: [
                            {
                                $map: {
                                    input: { $ifNull: ["$itemVendors", []] },
                                    as: "v",
                                    in: "$$v.name",
                                },
                            },
                            {
                                $map: {
                                    input: { $ifNull: ["$itemVendors", []] },
                                    as: "v",
                                    in: "$$v.fulfillment_type",
                                },
                            },
                            {
                                $map: {
                                    input: { $ifNull: ["$forcedVendor", []] },
                                    as: "v",
                                    in: "$$v.name",
                                },
                            },
                            {
                                $map: {
                                    input: { $ifNull: ["$forcedVendor", []] },
                                    as: "v",
                                    in: "$$v.fulfillment_type",
                                },
                            },
                            {
                                $map: {
                                    input: { $objectToArray: { $ifNull: ["$vendor_submissions", {}] } },
                                    as: "sub",
                                    in: "$$sub.k",
                                },
                            },
                        ],
                    },
                },
            },
            { $match: { vendor_filter_values: { $elemMatch: { $regex: vendorPattern, $options: "i" } } } }
        );
    }

    pipeline.push({
        $addFields: {
            hasPendingItem: {
                $anyElementTrue: {
                    $map: {
                        input: { $ifNull: ["$items", []] },
                        as: "it",
                        in: { $eq: [{ $ifNull: ["$$it.scale_status", "Need Scale"] }, "Pending"] },
                    },
                },
            },
            overall_status_bucket: {
                $let: {
                    vars: { s: { $ifNull: ["$scale_overall_status", "Need Scale"] } },
                    in: { $cond: [{ $in: ["$$s", ETSY_SCALE_KNOWN] }, "$$s", "Other"] },
                },
            },
            allItemsHaveScaleFile: {
                $let: {
                    vars: { orderItems: { $ifNull: ["$items", []] } },
                    in: {
                        $and: [
                            { $gt: [{ $size: "$$orderItems" }, 0] },
                            {
                                $allElementsTrue: {
                                    $map: {
                                        input: "$$orderItems",
                                        as: "it",
                                        in: {
                                            $gt: [
                                                {
                                                    $size: {
                                                        $filter: {
                                                            input: { $objectToArray: { $ifNull: ["$$it.fulfillment_file", {}] } },
                                                            as: "ff",
                                                            cond: {
                                                                $and: [
                                                                    { $ne: ["$$ff.v", null] },
                                                                    { $ne: ["$$ff.v", ""] },
                                                                ],
                                                            },
                                                        },
                                                    },
                                                },
                                                0,
                                            ],
                                        },
                                    },
                                },
                            },
                        ],
                    },
                },
            },
            vendor_failure_errors: {
                $filter: {
                    input: {
                        $map: {
                            input: { $objectToArray: { $ifNull: ["$vendor_submissions", {}] } },
                            as: "sub",
                            in: "$$sub.v.last_response.error",
                        },
                    },
                    as: "error",
                    cond: {
                        $and: [
                            { $ne: ["$$error", null] },
                            { $ne: ["$$error", ""] },
                        ],
                    },
                },
            },
        },
    });

    if (failureReason && String(failureReason).trim()) {
        const failurePattern = escapeRegExp(String(failureReason).trim());
        pipeline.push({
            $match: {
                vendor_failure_errors: {
                    $elemMatch: { $regex: failurePattern, $options: "i" },
                },
            },
        });
    }

    const hasScaleFileValue = String(hasScaleFile || "").trim().toLowerCase();
    if (["true", "false"].includes(hasScaleFileValue)) {
        pipeline.push({ $match: { allItemsHaveScaleFile: hasScaleFileValue === "true" } });
    }

    if (onlyPending) {
        pipeline.push({
            $addFields: {
                items: {
                    $filter: {
                        input: { $ifNull: ["$items", []] },
                        as: "it",
                        cond: { $eq: [{ $ifNull: ["$$it.scale_status", "Need Scale"] }, "Pending"] },
                    },
                },
            },
        });
        pipeline.push({ $match: { $expr: { $gt: [{ $size: { $ifNull: ["$items", []] } }, 0] } } });
    }

    return pipeline;
};

async function buildEtsyVendorProductDisplayMap(orders = []) {
    const vendorProductIds = new Set();
    for (const order of orders || []) {
        for (const item of order.items || []) {
            const vendorProductId = item?.cost_breakdown?.vendorProductId;
            if (vendorProductId) vendorProductIds.add(String(vendorProductId));
        }
    }

    const validIds = [...vendorProductIds]
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

    if (validIds.length === 0) return new Map();

    const vendorProducts = await db.vendorProduct.find({ _id: { $in: validIds } })
        .select("product_name vendor_id")
        .populate({ path: "vendor_id", select: "name" })
        .lean();

    return new Map((vendorProducts || []).map((vendorProduct) => {
        const vendorName = vendorProduct?.vendor_id?.name || "";
        const productName = vendorProduct?.product_name || "";
        return [
            String(vendorProduct._id),
            `${vendorName} - ${productName}`.trim(),
        ];
    }));
}

const mapEtsyScaleOrder = (order, { vendorProductDisplayMap = new Map() } = {}) => ({
    orderId: order.orderId,
    shopId: order.shopId ? String(order.shopId) : null,
    shopName: order.shop?.name || order.shop?.store || null,
    status: order.status || "",
    saleDate: order.saleDate,
    createdAt: order.createdAt,
    shipping_type: order.shipping_type || "Standard",
    customer_infor: getEtsyCustomerInfo(order),
    buyer: order.buyer || {},
    shipping: order.shipping || {},
    items: (order.items || []).map((item) => {
        const vendorProductId = item?.cost_breakdown?.vendorProductId || null;
        const vendorProductDisplayName = vendorProductId
            ? vendorProductDisplayMap.get(String(vendorProductId)) || null
            : null;
        return {
            orderItemId: item.orderItemId || item.transactionId || null,
            transactionId: item.transactionId || null,
            listingId: item.listingId || null,
            sku: item.sku || "",
            title: item.title || item.itemName || "",
            itemName: item.itemName || "",
            quantity: item.quantity || 1,
            variations: item.variations || {},
            variationsRaw: item.variationsRaw || "",
            baseImageUrl: item.baseImage?.imageUrl || null,
            snapshotImage: item.snapshotImage || null,
            customized_url: item.customized_url || "",
            asin: item.asin || "",
            cost_center: {
                vendorProductId,
                vendorProductDisplayName,
                vendor_display_name: vendorProductDisplayName,
                sizeValue: item?.cost_breakdown?.sizeValue || null,
                colorValue: item?.cost_breakdown?.colorValue || null,
                vendorProductSKU: item?.cost_breakdown?.matchedSku || null,
            },
            vendor_display_name: vendorProductDisplayName,
            tracking_info: buildEtsyTrackingInfoResponse(order, item),
            tracking_summary: buildEtsyTrackingSummary(order, item),
            fulfillment_file: toPlainFulfillmentFile(item.fulfillment_file),
            scale_status: item.scale_status || "Need Scale",
            qc_note: item.qc_note || "",
            cs_note: item.cs_note || "",
            ...buildCustomItemResponseFields(item, { includeExternalUrl: true }),
        };
    }),
    base_cost: order.base_cost || 0,
    tracking_summary: buildEtsyTrackingSummary(order, (order.items || [])[0] || {}),
    address_validation: order.address_validation?.isValid ?? null,
    address_validation_status: order.address_validation?.status || null,
    address_validation_detail: order.address_validation || null,
    scale_overall_status: order.scale_overall_status || "Need Scale",
    vendor_failure: buildEtsyVendorFailure(order),
    scaledBy: order.scaledBy
        ? { _id: order.scaledBy._id, full_name: order.scaledBy.full_name, email: order.scaledBy.email }
        : null,
    cs_assignment_status: order.cs_assignment_status || "Unassigned",
    csAssignedAt: order.csAssignedAt || null,
    cs_assignee: order.cs_assignee
        ? { _id: order.cs_assignee._id, full_name: order.cs_assignee.full_name, email: order.cs_assignee.email }
        : null,
    seller: order.sellerUser
        ? { _id: order.sellerUser._id, full_name: order.sellerUser.full_name, email: order.sellerUser.email }
        : null,
});

const getEtsyScaleList = async (req, res) => {
    try {
        const { page = 1, perPage = 10 } = req.query;
        const pipeline = buildEtsyScalePipeline(req, ETSY_SCALE_ACTIVE, { restrictCsToAssigned: true });
        const countResult = await EtsyOrder.aggregate([...pipeline, { $count: "total" }]);
        const totalCount = countResult?.[0]?.total || 0;
        const isAll = String(perPage).toLowerCase() === "all";
        const pageNum = parseInt(page, 10) || 1;
        const limitNum = isAll ? totalCount || 1 : parseInt(perPage, 10) || 10;
        const skip = isAll ? 0 : (pageNum - 1) * limitNum;

        pipeline.push({ $sort: { saleDate: 1, createdAt: 1 } });
        if (!isAll) pipeline.push({ $skip: skip }, { $limit: limitNum });

        const orders = await EtsyOrder.aggregate(pipeline);
        const vendorProductDisplayMap = await buildEtsyVendorProductDisplayMap(orders);
        return res.json({
            data: orders.map((order) => mapEtsyScaleOrder(order, { vendorProductDisplayMap })),
            totalCount,
            totalPages: isAll ? 1 : Math.ceil(totalCount / limitNum),
            currentPage: pageNum,
        });
    } catch (err) {
        logger.error(`getEtsyScaleList error: ${err.message}`);
        return res.status(500).json({ message: "Failed to retrieve Etsy scale list", error: err.message });
    }
};

const getEtsyQCList = async (req, res) => {
    try {
        const { page = 1, perPage = 10 } = req.query;
        const pipeline = buildEtsyScalePipeline(req, ETSY_QC_ACTIVE);
        const countResult = await EtsyOrder.aggregate([...pipeline, { $count: "total" }]);
        const totalCount = countResult?.[0]?.total || 0;
        const isAll = String(perPage).toLowerCase() === "all";
        const pageNum = parseInt(page, 10) || 1;
        const limitNum = isAll ? totalCount || 1 : parseInt(perPage, 10) || 10;
        const skip = isAll ? 0 : (pageNum - 1) * limitNum;

        pipeline.push({ $sort: { createdAt: -1 } });
        if (!isAll) pipeline.push({ $skip: skip }, { $limit: limitNum });

        const orders = await EtsyOrder.aggregate(pipeline);
        const vendorProductDisplayMap = await buildEtsyVendorProductDisplayMap(orders);
        return res.json({
            data: orders.map((order) => mapEtsyScaleOrder(order, { vendorProductDisplayMap })),
            totalCount,
            totalPages: isAll ? 1 : Math.ceil(totalCount / limitNum),
            currentPage: pageNum,
        });
    } catch (err) {
        logger.error(`getEtsyQCList error: ${err.message}`);
        return res.status(500).json({ message: "Failed to retrieve Etsy QC list", error: err.message });
    }
};

const getEtsyScaleStatistics = async (req, res) => {
    try {
        const pipeline = buildEtsyScalePipeline(req, ETSY_SCALE_ACTIVE, { restrictCsToAssigned: true });
        const [raw] = await EtsyOrder.aggregate([
            ...pipeline,
            { $group: { _id: "$overall_status_bucket", orders: { $sum: 1 }, pending: { $sum: { $cond: ["$hasPendingItem", 1, 0] } } } },
            { $group: { _id: null, totalOrders: { $sum: "$orders" }, byStatus: { $push: { k: "$_id", v: "$orders" } }, pendingAdj: { $sum: "$pending" } } },
            { $project: { _id: 0, totalOrders: 1, counts: { $arrayToObject: "$byStatus" }, pendingAdj: 1 } },
        ]);
        const c = raw?.counts || {};
        const counts = {
            "Need Scale": c["Need Scale"] || 0,
            Pending: raw?.pendingAdj || c.Pending || 0,
            Ready: c.Ready || 0,
            Sent: c.Sent || 0,
            Failed: c.Failed || 0,
            "QC Rejected": c["QC Rejected"] || 0,
            Other: c.Other || 0,
        };
        counts.All = counts["Need Scale"] + counts.Pending + counts.Sent + counts["QC Rejected"];
        return res.json({ overall: { totalOrders: raw?.totalOrders || 0, counts }, breakdown: [], timeseries: [] });
    } catch (err) {
        return res.status(500).json({ message: "Failed to retrieve Etsy scale statistics", error: err.message });
    }
};

const getEtsyQCStatistics = async (req, res) => {
    try {
        const statisticsReq = {
            ...req,
            query: {
                ...req.query,
            },
        };
        delete statisticsReq.query.scale_status;

        const pipeline = buildEtsyScalePipeline(statisticsReq, ETSY_QC_ACTIVE);
        const [raw] = await EtsyOrder.aggregate([
            ...pipeline,
            { $group: { _id: "$overall_status_bucket", orders: { $sum: 1 } } },
            { $group: { _id: null, totalOrders: { $sum: "$orders" }, byStatus: { $push: { k: "$_id", v: "$orders" } } } },
            { $project: { _id: 0, totalOrders: 1, counts: { $arrayToObject: "$byStatus" } } },
        ]);
        const c = raw?.counts || {};
        const counts = {
            "Need Scale": c["Need Scale"] || 0,
            Pending: c.Pending || 0,
            Ready: c.Ready || 0,
            Sent: c.Sent || 0,
            Failed: c.Failed || 0,
            "QC Rejected": c["QC Rejected"] || 0,
            "Address Invalid": c["Address Invalid"] || 0,
            Other: c.Other || 0,
        };
        counts.All = counts.Pending + counts.Sent + counts["QC Rejected"] + counts.Ready + counts.Failed + counts["Address Invalid"];
        return res.json({ overall: { totalOrders: counts.All, counts } });
    } catch (err) {
        return res.status(500).json({ message: "Failed to retrieve Etsy QC statistics", error: err.message });
    }
};

const uploadEtsyFulfillmentFileForItem = [
    etsyScaleUpload.array("files"),
    async (req, res) => {
        const startedAt = Date.now();
        let stage = "received";
        const uploadedFiles = [];
        const buildDiagnostics = (overrides = {}) => ({
            orderId: String(req.params?.orderId || req.body?.orderId || ""),
            transactionId: String(req.params?.transactionId || ""),
            receivedFiles: req.files?.length || 0,
            uploadedFiles: uploadedFiles.length,
            totalBytes: (req.files || []).reduce((sum, file) => sum + (Number(file?.size) || 0), 0),
            stage,
            durationMs: Date.now() - startedAt,
            ...overrides,
        });
        try {
            const { transactionId } = req.params;
            const userId = req.user?.userId || req.user?.id || req.user?._id || null;
            if (!req.files?.length) return res.status(400).json({ message: "Missing files", diagnostics: buildDiagnostics() });

            let positions = [];
            try {
                stage = "parse_meta";
                positions = JSON.parse(req.body?.meta || "[]");
            } catch {
                return res.status(400).json({ message: "Invalid meta JSON", diagnostics: buildDiagnostics() });
            }
            if (positions.length !== req.files.length) {
                return res.status(400).json({ message: "Files count not match positions", diagnostics: buildDiagnostics({ metaPositions: positions.length }) });
            }

            stage = "find_order";
            const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
            if (!order) return res.status(404).json({ message: "Etsy order not found", diagnostics: buildDiagnostics() });
            const accessError = ensureSellerCanAccessEtsyOrder(req, order);
            if (accessError) return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError, diagnostics: buildDiagnostics() });

            stage = "find_item";
            const item = (order.items || []).find((entry) => String(entry.transactionId) === String(transactionId));
            if (!item) return res.status(404).json({ message: "Etsy order item not found", diagnostics: buildDiagnostics() });

            if (!item.fulfillment_file || !(item.fulfillment_file instanceof Map)) {
                item.fulfillment_file = new Map(Object.entries(toPlainFulfillmentFile(item.fulfillment_file)));
            }

            stage = "upload_r2";
            for (let i = 0; i < req.files.length; i += 1) {
                const file = req.files[i];
                const pos = String(positions[i]?.position || "").trim().toLowerCase();
                if (!pos) return res.status(400).json({ message: `Missing position for file index ${i}`, diagnostics: buildDiagnostics({ fileIndex: i }) });
                const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
                const safeOrderId = String(order.orderId).replace(/[^\w.-]+/g, "_");
                const safeTx = String(transactionId).replace(/[^\w.-]+/g, "_");
                const safePos = pos.replace(/[^\w.-]+/g, "_");
                const fileStartedAt = Date.now();
                const up = await uploadFilePathToR2({
                    filePath: file.path,
                    originalName: file.originalname,
                    mimeType: file.mimetype,
                    size: file.size,
                    folder: "fulfillment_files",
                    key: `fulfillment_files/etsy-${safeOrderId}-${safeTx}-${safePos}${ext}`,
                });
                item.fulfillment_file.set(pos, up.url);
                uploadedFiles.push({
                    index: i,
                    position: pos,
                    originalName: file.originalname,
                    mimeType: file.mimetype,
                    size: file.size,
                    provider: up.provider,
                    bucket: up.bucket,
                    folder: up.folder,
                    key: up.key,
                    url: up.url,
                    durationMs: Date.now() - fileStartedAt,
                });
            }

            stage = "save_order";
            item.scale_status = "Pending";
            order.scale_overall_status = computeEtsyOverallScaleStatus(order.items);
            if (userId && mongoose.Types.ObjectId.isValid(userId)) order.scaleId = new mongoose.Types.ObjectId(userId);
            order.markModified("items");
            await order.save();
            stage = "completed";

            return res.json({
                message: "Uploaded Etsy fulfillment files successfully",
                fulfillment_file: toPlainFulfillmentFile(item.fulfillment_file),
                item_scale_status: item.scale_status,
                order_scale_overall_status: order.scale_overall_status,
                uploaded_files: uploadedFiles,
                diagnostics: buildDiagnostics(),
            });
        } catch (err) {
            logger.error(`uploadEtsyFulfillmentFileForItem error: ${err.message}`);
            return res.status(500).json({
                message: "Upload failed",
                error: err.message,
                error_name: err.name,
                error_code: err.code,
                uploaded_files: uploadedFiles,
                diagnostics: buildDiagnostics(),
            });
        } finally {
            for (const file of req.files || []) {
                if (file?.path) fs.unlink(file.path, () => { });
            }
        }
    },
];

const confirmEtsyScaleForItem = async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { decision, note } = req.body || {};
        const user = req.user;
        const d = String(decision || "").toLowerCase();
        if (!["approve", "reject"].includes(d)) {
            return res.status(400).json({ message: 'Invalid decision. Must be "approve" or "reject".' });
        }

        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) return res.status(404).json({ message: "Etsy order not found" });
        const accessError = ensureSellerCanAccessEtsyOrder(req, order);
        if (accessError) return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError });

        const item = (order.items || []).find((entry) => String(entry.transactionId) === String(transactionId));
        if (!item) return res.status(404).json({ message: "Etsy order item not found" });

        const before = {
            item_scale_status: item.scale_status,
            item_qc_note: item.qc_note || "",
            item_ff: toPlainFulfillmentFile(item.fulfillment_file),
            order_scale_overall_status: order.scale_overall_status,
        };

        if (d === "reject") {
            item.scale_status = "QC Rejected";
            item.fulfillment_file = new Map();
            if (note !== undefined) item.qc_note = String(note || "").trim();
            order.scale_overall_status = "QC Rejected";
            order.markModified("items");
            await order.save();

            await logOrderHistory({
                orderDoc: order,
                action: "SCALE_REJECT_ITEM",
                description: `QC rejected Etsy item ${transactionId}${note ? `: ${String(note).slice(0, 120)}` : ""}`,
                changes: [
                    { field: "items.scale_status", from: before.item_scale_status, to: item.scale_status },
                    { field: "items.qc_note", from: before.item_qc_note, to: item.qc_note || "" },
                    { field: "items.fulfillment_file", from: before.item_ff, to: toPlainFulfillmentFile(item.fulfillment_file) },
                    { field: "scale_overall_status", from: before.order_scale_overall_status, to: order.scale_overall_status },
                ],
                orderItemId: transactionId,
                user,
                context: {
                    source: "PORTAL",
                    ip: req.ip,
                    userAgent: req.headers["user-agent"],
                },
            });
            await logOrderLifecycleEvent(buildOrderLifecyclePayload({
                order,
                req,
                fallbackPlatform: "etsy",
                stage: "SCALE",
                eventType: "SCALE_ITEM_REJECTED",
                status: "success",
                message: `QC rejected Etsy item ${transactionId}`,
                metadata: {
                    orderItemId: transactionId,
                    note: note ? String(note).slice(0, 120) : "",
                    fromScaleStatus: before.item_scale_status,
                    toScaleStatus: item.scale_status,
                    fromOverallStatus: before.order_scale_overall_status,
                    toOverallStatus: order.scale_overall_status,
                },
            }));
            await logOrderLifecycleEvent(buildOrderLifecyclePayload({
                order,
                req,
                fallbackPlatform: "etsy",
                stage: "QC",
                eventType: "QC_REJECTED",
                status: "success",
                message: `QC rejected Etsy item ${transactionId}`,
                metadata: {
                    orderItemId: transactionId,
                    note: note ? String(note).slice(0, 120) : "",
                },
            }));

            return res.json({
                message: "Etsy scale rejected. Item set to QC Rejected.",
                item_scale_status: item.scale_status,
                qc_note: item.qc_note || "",
                order_scale_overall_status: order.scale_overall_status,
            });
        } else {
            if (!hasAnyFulfillmentFile(item.fulfillment_file)) {
                return res.status(400).json({
                    message: "Missing print files. Please upload fulfillment_file before approval.",
                });
            }
            item.scale_status = "Complete";
            if (note !== undefined) item.qc_note = String(note || "").trim();
            order.scale_overall_status = computeEtsyOverallScaleStatus(order.items);
        }

        order.markModified("items");

        await logOrderHistory({
            orderDoc: order,
            action: "SCALE_APPROVE_ITEM",
            description: `Approved Etsy item ${transactionId}${note ? `: ${String(note).slice(0, 120)}` : ""}`,
            changes: [
                { field: "items.scale_status", from: before.item_scale_status, to: item.scale_status },
                { field: "items.qc_note", from: before.item_qc_note, to: item.qc_note || "" },
                { field: "scale_overall_status", from: before.order_scale_overall_status, to: order.scale_overall_status },
            ],
            orderItemId: transactionId,
            user,
            context: {
                source: "PORTAL",
                ip: req.ip,
                userAgent: req.headers["user-agent"],
            },
        });
        await logOrderLifecycleEvent(buildOrderLifecyclePayload({
            order,
            req,
            fallbackPlatform: "etsy",
            stage: "SCALE",
            eventType: "SCALE_ITEM_APPROVED",
            status: "success",
            message: `Approved Etsy item ${transactionId}`,
            metadata: {
                orderItemId: transactionId,
                note: note ? String(note).slice(0, 120) : "",
                fromScaleStatus: before.item_scale_status,
                toScaleStatus: item.scale_status,
                fromOverallStatus: before.order_scale_overall_status,
                toOverallStatus: order.scale_overall_status,
            },
        }));
        await logOrderLifecycleEvent(buildOrderLifecyclePayload({
            order,
            req,
            fallbackPlatform: "etsy",
            stage: "QC",
            eventType: "QC_APPROVED",
            status: "success",
            message: `QC approved Etsy item ${transactionId}`,
            metadata: {
                orderItemId: transactionId,
                note: note ? String(note).slice(0, 120) : "",
            },
        }));

        if (order.scale_overall_status === "Ready") {
            await logOrderHistory({
                orderDoc: order,
                action: "SCALE_ORDER_READY",
                description: "All Etsy items approved. Order is Ready.",
                changes: [
                    {
                        field: "scale_overall_status",
                        from: before.order_scale_overall_status,
                        to: "Ready",
                    },
                ],
                user,
                context: {
                    source: "PORTAL",
                    ip: req.ip,
                    userAgent: req.headers["user-agent"],
                },
            });
            await logOrderLifecycleEvent(buildOrderLifecyclePayload({
                order,
                req,
                fallbackPlatform: "etsy",
                stage: "SCALE",
                eventType: "SCALE_ORDER_READY",
                status: "success",
                message: "All Etsy items approved. Order is Ready.",
                metadata: {
                    orderItemId: transactionId,
                    fromOverallStatus: before.order_scale_overall_status,
                    toOverallStatus: "Ready",
                },
            }));

            if (isEtsyAddressInvalid(order)) {
                order.scale_overall_status = "Address Invalid";
                await order.save();

                await logOrderHistory({
                    orderDoc: order,
                    action: "UPDATE_SCALE_STATUS",
                    description: "Etsy address invalid detected. Overall status set to Address Invalid.",
                    changes: [
                        { field: "scale_overall_status", from: "Ready", to: "Address Invalid" },
                    ],
                    user,
                    context: {
                        source: "SYSTEM",
                        ip: req.ip,
                        userAgent: req.headers["user-agent"],
                    },
                });

                return res.status(409).json({
                    message: buildEtsyInvalidAddressMessage(order),
                    address_validation: order.address_validation || null,
                });
            }

            await order.save();
            return res.json({
                message: "Approved and Etsy order is ready for production.",
                item_scale_status: item.scale_status,
                order_scale_overall_status: order.scale_overall_status,
            });
        }

        await order.save();

        return res.json({
            message: "Etsy item approved. Waiting for other items to be approved.",
            item_scale_status: item.scale_status,
            qc_note: item.qc_note || "",
            order_scale_overall_status: order.scale_overall_status,
        });
    } catch (err) {
        return res.status(500).json({ message: "Confirm failed", error: err.message });
    }
};

const updateEtsyItemNote = (field) => async (req, res) => {
    try {
        const { transactionId } = req.params;
        const noteValue = String(req.body?.[field] || "").trim();
        if (noteValue.length > 2000) {
            return res.status(400).json({ message: `${field} exceeds 2000 characters.` });
        }
        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) return res.status(404).json({ message: "Etsy order not found" });
        const accessError = ensureSellerCanAccessEtsyOrder(req, order);
        if (accessError) return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError });

        const item = (order.items || []).find((entry) => String(entry.transactionId) === String(transactionId));
        if (!item) return res.status(404).json({ message: "Etsy order item not found" });
        item[field] = noteValue;
        order.markModified("items");
        await order.save();

        return res.json({
            message: `Etsy ${field} updated.`,
            orderId: order.orderId,
            transactionId,
            [field]: item[field],
        });
    } catch (err) {
        return res.status(500).json({ message: `Update ${field} failed`, error: err.message });
    }
};

const updateEtsyQCNoteForItem = updateEtsyItemNote("qc_note");
const updateEtsyCSNoteForItem = updateEtsyItemNote("cs_note");

const updateEtsyOrderItemQuantity = async (req, res) => {
    try {
        const { orderId, transactionId } = req.params;
        const { quantity } = req.body;

        if (quantity === undefined || quantity === null) {
            return res.status(400).json({
                message: "Quantity is required",
            });
        }

        const parsedQuantity = Number(quantity);

        if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1) {
            return res.status(400).json({
                message: "Quantity must be an integer greater than 0",
            });
        }

        const order = await EtsyOrder.findOne({ orderId });
        if (!order) {
            return res.status(404).json({
                message: "Etsy order or order item not found",
            });
        }

        const item = (order.items || []).find(
            (entry) => String(entry.transactionId) === String(transactionId)
        );
        if (!item) {
            return res.status(404).json({
                message: "Etsy order or order item not found",
            });
        }

        const oldQuantity = item.quantity ?? null;

        if (oldQuantity === parsedQuantity) {
            return res.status(200).json({
                message: "No change",
                data: {
                    orderId,
                    transactionId,
                    orderItemId: transactionId,
                    quantity: parsedQuantity,
                },
            });
        }

        item.quantity = parsedQuantity;
        order.numberOfItems = (order.items || []).reduce(
            (sum, entry) => sum + (Number(entry.quantity) || 0),
            0
        );
        order.markModified("items");
        await order.save();

        await logOrderHistory({
            orderDoc: order,
            action: "UPDATE_ITEM_QUANTITY",
            description: `Etsy order item quantity changed from ${oldQuantity} to ${parsedQuantity}`,
            changes: [
                {
                    field: "items.quantity",
                    from: oldQuantity,
                    to: parsedQuantity,
                },
                {
                    field: "numberOfItems",
                    from: null,
                    to: order.numberOfItems,
                },
            ],
            orderItemId: transactionId,
            user: req.user,
            context: {
                source: "PORTAL",
                ip: req.ip,
                userAgent: req.headers["user-agent"],
            },
        });

        return res.status(200).json({
            message: "Etsy order item quantity updated successfully",
            data: {
                orderId,
                transactionId,
                orderItemId: transactionId,
                quantity: parsedQuantity,
                numberOfItems: order.numberOfItems,
            },
        });
    } catch (error) {
        return res.status(500).json({
            message: "Failed to update Etsy order item quantity",
            error: error.message,
        });
    }
};

const openCaseInEtsyOrder = async (req, res) => {
    try {
        const { orderId, caseIds } = req.body;

        if (!orderId || !Array.isArray(caseIds)) {
            return res
                .status(400)
                .json({ message: "Missing orderId or caseIds (should be an array)" });
        }

        const order = await EtsyOrder.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        if (!Array.isArray(order.case)) {
            order.case = [];
        }

        const oldCases = order.case.map((id) => String(id));
        const newCaseIds = caseIds.filter((id) => !oldCases.includes(String(id)));

        if (newCaseIds.length === 0) {
            return res.status(200).json({
                message: "No new case added",
                orderId,
                case: order.case,
            });
        }

        order.case.push(...newCaseIds);
        await order.save();

        await logOrderHistory({
            orderDoc: order,
            action: "OPEN_CASE",
            description: `Added ${newCaseIds.length} case(s) to Etsy order`,
            changes: [
                {
                    field: "case",
                    from: oldCases,
                    to: order.case.map((id) => String(id)),
                },
            ],
            user: req.user,
            context: {
                source: "PORTAL",
                ip: req.ip,
                userAgent: req.headers["user-agent"],
            },
        });

        return res.status(200).json({
            message: "Case field appended successfully",
            orderId,
            case: order.case,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Failed to append case field",
            error: error.message,
        });
    }
};

const removeCaseFromEtsyOrder = async (req, res) => {
    try {
        const { orderId, caseIds } = req.body;

        if (!orderId || !Array.isArray(caseIds)) {
            return res
                .status(400)
                .json({ message: "Missing orderId or caseIds (should be an array)" });
        }

        const normalizedCaseIds = [...new Set(caseIds.map((id) => String(id)))];

        const invalidIds = normalizedCaseIds.filter(
            (id) => !mongoose.Types.ObjectId.isValid(id)
        );
        if (invalidIds.length > 0) {
            return res.status(400).json({
                message: "Invalid caseId(s)",
                invalidIds,
            });
        }

        const order = await EtsyOrder.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        if (!Array.isArray(order.case)) {
            order.case = [];
        }

        const oldCases = order.case.map((id) => String(id));
        const newCases = oldCases.filter((id) => !normalizedCaseIds.includes(id));

        if (newCases.length === oldCases.length) {
            return res.status(200).json({
                message: "No case removed",
                orderId,
                case: order.case,
            });
        }

        order.case = newCases;
        await order.save();

        await logOrderHistory({
            orderDoc: order,
            action: "REMOVE_CASE",
            description: `Removed ${oldCases.length - newCases.length} case(s) from Etsy order`,
            changes: [
                {
                    field: "case",
                    from: oldCases,
                    to: newCases,
                },
            ],
            user: req.user,
            context: {
                source: "PORTAL",
                ip: req.ip,
                userAgent: req.headers["user-agent"],
            },
        });

        return res.status(200).json({
            message: "Case(s) removed successfully",
            orderId,
            case: order.case,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Failed to remove case(s)",
            error: error.message,
        });
    }
};

async function buildNextEtsyReplaceOrderId(baseOrderId) {
    const base = String(baseOrderId || "").replace(/-R\d+$/i, "");
    const regex = new RegExp(`^${escapeRegExp(base)}-R(\\d+)$`, "i");
    const query = EtsyOrder.find(
        { orderId: { $regex: new RegExp(`^${escapeRegExp(base)}-R\\d+$`, "i") } },
        { orderId: 1 }
    );
    const exists = typeof query.lean === "function" ? await query.lean() : await query;

    if (!exists || exists.length === 0) return `${base}-R1`;

    let max = 0;
    for (const doc of exists) {
        const match = String(doc.orderId || "").match(regex);
        if (match && match[1]) max = Math.max(max, Number(match[1]));
    }
    return `${base}-R${max + 1}`;
}

function toPlainEtsyOrder(order) {
    if (!order) return null;
    if (typeof order.toObject === "function") return order.toObject();
    return JSON.parse(JSON.stringify(order));
}

function sanitizeEtsyItemForReplace(srcItem, { note = "", sourceOrderId = "" } = {}) {
    const dst = JSON.parse(JSON.stringify(srcItem || {}));
    const originalTransactionId = String(srcItem?.transactionId || "");
    const originalOrderItemId = String(srcItem?.orderItemId || originalTransactionId || "");
    const nextTransactionId = new mongoose.Types.ObjectId().toHexString();

    dst.transactionId = nextTransactionId;
    dst.orderItemId = nextTransactionId;
    dst.fulfillment_file = {};
    dst.tracking_info = {
        fulfillment: "",
        tracking: "",
        status: "New",
        note: "",
        updated_at: new Date(),
    };
    dst.scale_status = "Need Scale";
    dst.qc_note = "";
    dst.cs_note = note ? String(note) : "";
    dst.cost_breakdown = undefined;
    dst.quantity = Number(srcItem?.quantity || 1);
    dst.replace_meta = {
        is_replacement_item: true,
        source_order_id: sourceOrderId,
        original_transaction_id: originalTransactionId,
        original_order_item_id: originalOrderItemId,
        created_at: new Date(),
        reason: note || "",
    };

    if (Array.isArray(dst.customFiles)) {
        dst.customFiles = dst.customFiles.map((file) => ({
            ...file,
            transactionId: nextTransactionId,
        }));
    }

    return dst;
}

const createEtsyReplacementOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const {
            transactionIds,
            orderItemIds,
            note = "",
        } = req.body || {};
        const replaceNote = typeof note === "string" ? note.trim() : String(note || "").trim();

        const sourceDoc = await EtsyOrder.findOne({ orderId });
        if (!sourceDoc) return res.status(404).json({ message: "Etsy order not found" });

        const src = toPlainEtsyOrder(sourceDoc);
        const sourceItems = Array.isArray(src.items) ? src.items : [];
        if (sourceItems.length === 0) {
            return res.status(400).json({ message: "Source order has no items" });
        }

        let selected = [];
        if (sourceItems.length === 1) {
            selected = [sourceItems[0]];
        } else {
            const requestedIds = Array.isArray(transactionIds) && transactionIds.length
                ? transactionIds
                : orderItemIds;
            if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
                return res.status(400).json({
                    message: "This Etsy order has multiple items. Please provide body.transactionIds as an array of transactionId to replace.",
                    availableTransactionIds: sourceItems.map((item) => item.transactionId).filter(Boolean),
                    availableOrderItemIds: sourceItems.map((item) => item.orderItemId || item.transactionId).filter(Boolean),
                });
            }

            const requestedSet = new Set(requestedIds.map(String));
            selected = sourceItems.filter((item) => (
                requestedSet.has(String(item.transactionId || "")) ||
                requestedSet.has(String(item.orderItemId || ""))
            ));

            if (selected.length === 0) {
                return res.status(400).json({
                    message: "No matching transactionIds found in source Etsy order",
                    availableTransactionIds: sourceItems.map((item) => item.transactionId).filter(Boolean),
                    availableOrderItemIds: sourceItems.map((item) => item.orderItemId || item.transactionId).filter(Boolean),
                });
            }
        }

        const newOrderId = await buildNextEtsyReplaceOrderId(src.orderId);
        const newItems = selected.map((item) => sanitizeEtsyItemForReplace(item, {
            note: replaceNote,
            sourceOrderId: src.orderId,
        }));

        const now = new Date();
        const payload = {
            orderId: newOrderId,
            shopId: src.shopId,
            saleDate: now,
            paidAt: now,
            shippedAt: null,
            status: "New",
            orderType: src.orderType,
            listingsType: src.listingsType,
            paymentType: src.paymentType,
            paymentMethod: src.paymentMethod,
            currency: src.currency,
            buyer: src.buyer || null,
            seller: src.seller || null,
            coupon: src.coupon || null,
            shipping: src.shipping || null,
            shipping_type: src.shipping_type || "Standard",
            totals: src.totals || null,
            base_cost: 0,
            base_cost_computed_at: null,
            base_cost_shipping_groups: [],
            customer_infor: src.customer_infor || null,
            scale_overall_status: "Need Scale",
            scaleId: null,
            csAssigneeId: null,
            csAssignedBy: null,
            csAssignedAt: null,
            cs_assignment_status: "Unassigned",
            grabink_submission: {
                sent: false,
                sent_at: null,
                attempt_count: 0,
                last_response: null,
                external_id: null,
            },
            vendor_submissions: undefined,
            fulfillment_platform_v2_submission: {
                sent: false,
                sent_at: null,
                attempt_count: 0,
                last_response: null,
                sourceChannel: "ETSY",
            },
            fulfilled_at: null,
            external_order_id: null,
            forced_vendor_id: src.forced_vendor_id || null,
            numberOfItems: newItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
            sumbittedoetsy: false,
            case: [],
            items: newItems,
            address_validation: {
                provider: "smarty",
                scope: "etsy_us_street",
                envSource: "ETSY_US_STREET_SMARTY_*",
                status: "pending",
                isValid: null,
                checkedAt: null,
                httpStatus: null,
                errorCode: null,
                errorMessage: null,
                retryable: false,
                accountIssue: false,
                request: null,
                smartyResponse: null,
            },
            replace_meta: {
                is_replacement: true,
                replace_of_order_id: src.orderId,
                created_at: now,
                reason: replaceNote || "",
                source_transaction_ids: selected.map((item) => item.transactionId).filter(Boolean),
                source_order_item_ids: selected.map((item) => item.orderItemId || item.transactionId).filter(Boolean),
            },
        };

        const created = await EtsyOrder.create(payload);
        await validateAddressIfNeeded(created, { force: true });
        if (created.address_validation?.isValid === false) {
            created.scale_overall_status = "Address Invalid";
            await created.save();
        }

        await logOrderHistory({
            orderDoc: created,
            action: "CREATE_REPLACEMENT_ORDER",
            description: `Created Etsy replacement order ${created.orderId} from ${src.orderId}`,
            changes: [
                {
                    field: "replace_meta.replace_of_order_id",
                    from: null,
                    to: src.orderId,
                },
                {
                    field: "items",
                    from: sourceItems.length,
                    to: newItems.length,
                },
            ],
            user: req.user,
            context: {
                source: "PORTAL",
                ip: req.ip,
                userAgent: req.headers["user-agent"],
            },
        });

        const replacementTransactionIds = newItems.map((item) => item.transactionId);
        return res.json({
            message: "Replacement order created",
            source_order_id: src.orderId,
            replacement_order_id: created.orderId,
            items_copied: newItems.length,
            selected_transaction_ids: replacementTransactionIds,
            selected_order_item_ids: replacementTransactionIds,
            address_validation: created.address_validation,
            scale_overall_status: created.scale_overall_status,
        });
    } catch (err) {
        console.error("createEtsyReplacementOrder error:", err);
        return res.status(500).json({
            message: "Failed to create replacement order",
            error: err.message,
        });
    }
};

const resetEtsyScaleForOrdersBulk = async (req, res) => {
    try {
        const { orderIds = [], note = "" } = req.body || {};
        const resetNote = typeof note === "string" ? note.trim() : "";

        if (!Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({
                message: "orderIds must be a non-empty array",
            });
        }

        const results = [];

        for (const oid of orderIds) {
            try {
                const order = await EtsyOrder.findOne({ orderId: oid });
                if (!order) {
                    results.push({
                        orderId: oid,
                        status: "failed",
                        error: "Etsy order not found",
                    });
                    continue;
                }

                const previousOverallStatus = order.scale_overall_status || "Need Scale";
                const previousStatus = order.status || "New";
                const previousScaleId = order.scaleId || null;
                const itemChanges = [];

                for (const item of order.items || []) {
                    const transactionId = item?.transactionId || item?.orderItemId || "";
                    itemChanges.push({
                        transactionId,
                        scale_status: item?.scale_status || "Need Scale",
                        qc_note: item?.qc_note || "",
                        fulfillment_file: toPlainFulfillmentFile(item?.fulfillment_file),
                    });

                    item.scale_status = "Need Scale";
                    item.fulfillment_file = new Map();
                    item.qc_note = resetNote;
                }

                order.scale_overall_status = "Need Scale";
                order.status = "New";
                order.scaleId = null;
                order.markModified("items");

                await order.save();

                await logOrderHistory({
                    orderDoc: order,
                    action: "RESET_SCALE_BULK",
                    description: "Etsy scale reset to Need Scale for all items",
                    changes: [
                        { field: "scale_overall_status", from: previousOverallStatus, to: "Need Scale" },
                        { field: "status", from: previousStatus, to: "New" },
                        { field: "scaleId", from: previousScaleId, to: null },
                        {
                            field: "items.scale",
                            from: itemChanges,
                            to: (order.items || []).map((item) => ({
                                transactionId: item?.transactionId || item?.orderItemId || "",
                                scale_status: item?.scale_status || "Need Scale",
                                qc_note: item?.qc_note || "",
                                fulfillment_file: toPlainFulfillmentFile(item?.fulfillment_file),
                            })),
                        },
                    ],
                    user: req.user,
                    context: {
                        source: "PORTAL",
                        ip: req.ip,
                        userAgent: req.headers["user-agent"],
                    },
                });

                results.push({
                    orderId: oid,
                    status: "success",
                    scale_overall_status: "Need Scale",
                });
            } catch (err) {
                results.push({
                    orderId: oid,
                    status: "failed",
                    error: err.message,
                });
            }
        }

        return res.json({
            message: "Bulk reset completed",
            total: results.length,
            results,
        });
    } catch (err) {
        return res.status(500).json({
            message: "Bulk reset failed",
            error: err.message,
        });
    }
};

const reopenEtsyQc = async (req, res) => {
    try {
        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) return res.status(404).json({ message: "Etsy order not found" });

        const accessError = ensureSellerCanAccessEtsyOrder(req, order);
        if (accessError) return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError });

        const orderStatus = String(order.status || "").trim();
        if (["Shipped", "Cancelled", "Canceled", "Fulfilled"].includes(orderStatus)) {
            return res.status(409).json({
                message: `Cannot reopen QC for order status ${orderStatus}`,
                status: orderStatus,
            });
        }

        const previousOverallStatus = order.scale_overall_status || "Need Scale";
        if (!["Failed", "Ready"].includes(previousOverallStatus)) {
            return res.status(409).json({
                message: "Only Etsy orders with scale_overall_status Failed or Ready can be reopened for QC",
                scale_overall_status: previousOverallStatus,
            });
        }

        const items = Array.isArray(order.items) ? order.items : [];
        if (items.length === 0) {
            return res.status(409).json({ message: "Cannot reopen QC because this Etsy order has no items" });
        }

        const notCompleteItems = items
            .filter((item) => String(item?.scale_status || "").trim() !== "Complete")
            .map((item) => item?.transactionId || item?.orderItemId || "");
        if (notCompleteItems.length > 0) {
            return res.status(409).json({
                message: "Cannot reopen QC because not all items are Complete",
                items: notCompleteItems,
            });
        }

        const missingFileItems = items
            .filter((item) => !hasAnyFulfillmentFile(item?.fulfillment_file))
            .map((item) => item?.transactionId || item?.orderItemId || "");
        if (missingFileItems.length > 0) {
            return res.status(409).json({
                message: "Cannot reopen QC because some items are missing scale files",
                items: missingFileItems,
            });
        }

        const previousItems = items.map((item) => ({
            transactionId: item?.transactionId || item?.orderItemId || "",
            scale_status: item?.scale_status || "Need Scale",
            fulfillment_file: toPlainFulfillmentFile(item?.fulfillment_file),
        }));

        for (const item of items) {
            item.scale_status = "Pending";
        }
        order.scale_overall_status = "Pending";
        order.markModified("items");
        await order.save();

        await logOrderHistory({
            orderDoc: order,
            action: "UPDATE_SCALE_STATUS",
            description: "Etsy order reopened for QC without clearing scale files",
            changes: [
                { field: "scale_overall_status", from: previousOverallStatus, to: "Pending" },
                {
                    field: "items.scale_status",
                    from: previousItems,
                    to: items.map((item) => ({
                        transactionId: item?.transactionId || item?.orderItemId || "",
                        scale_status: item?.scale_status || "Need Scale",
                        fulfillment_file: toPlainFulfillmentFile(item?.fulfillment_file),
                    })),
                },
            ],
            user: req.user,
            context: {
                source: "PORTAL",
                ip: req.ip,
                userAgent: req.headers["user-agent"],
            },
        });

        return res.json({
            message: "Etsy order reopened for QC",
            orderId: order.orderId,
            scale_overall_status: order.scale_overall_status,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Failed to reopen Etsy order for QC",
            error: error.message,
        });
    }
};

const retrySendEtsyFulfillment = async (req, res) => {
    try {
        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) return res.status(404).json({ message: "Etsy order not found" });

        const accessError = ensureSellerCanAccessEtsyOrder(req, order);
        if (accessError) {
            return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError });
        }

        const orderStatus = String(order.status || "").trim();
        if (["Shipped", "Cancelled", "Canceled", "Fulfilled"].includes(orderStatus)) {
            return res.status(409).json({
                message: `Cannot retry vendor send for order status ${orderStatus}`,
                status: orderStatus,
            });
        }

        if (isEtsyAddressInvalid(order)) {
            return res.status(409).json({
                message: buildEtsyInvalidAddressMessage(order),
                address_validation: order.address_validation || null,
            });
        }

        const okToSend =
            order.scale_overall_status === "Ready" ||
            order.scale_overall_status === "Failed";
        if (!okToSend) {
            return res.status(409).json({
                message: "Etsy order is not ready to send.",
                scale_overall_status: order.scale_overall_status,
            });
        }

        let providerKey = String(req.query.provider || req.body?.provider || "").trim().toLowerCase();
        if (!providerKey) {
            try {
                const resolved = await resolveEtsyProviderFromOrder(order);
                providerKey = resolved.providerKey || "";
            } catch (err) {
                const availableProviders = (FulfillmentService.PROVIDERS || []).map((entry) => entry.key);
                const providersHint = availableProviders.length ? availableProviders.join(" | ") : "grabink";
                return res.status(err.status || 409).json({
                    message: "Unable to auto-select provider because multiple vendors were detected for this Etsy order.",
                    error: err.message,
                    providers: err.providers || [],
                    hint: `Please specify "provider" in query/body, e.g., ?provider=${providersHint}`,
                });
            }
        }

        const availableProviders = (FulfillmentService.PROVIDERS || []).map((entry) => entry.key);
        const providersHint = availableProviders.length ? availableProviders.join(" | ") : "grabink";
        if (!providerKey) {
            return res.status(409).json({
                message: "Unable to determine provider automatically.",
                hint: `Please specify "provider" in query/body, e.g., ?provider=${providersHint}`,
            });
        }
        if (availableProviders.length && !availableProviders.includes(providerKey)) {
            return res.status(400).json({
                message: `Unknown provider: ${providerKey}`,
                hint: `Valid providers: ${providersHint}`,
            });
        }

        const submissions = order.vendor_submissions || {};
        const submission =
            submissions[providerKey] ||
            (providerKey === "grabink" ? order.grabink_submission : null);
        if (submission?.sent) {
            return res.status(409).json({
                message: `Etsy order already sent to ${providerKey}.`,
                provider: providerKey,
                last_response: submission?.last_response || null,
                sent_at: submission?.sent_at || null,
            });
        }

        const result = await sendEtsyOrderToVendor({
            order,
            provider: providerKey,
            req,
            previousOverallStatus: order.scale_overall_status,
        });

        return res.json({
            message: result.alreadySent
                ? `Etsy order already sent to ${result.vendorKey}.`
                : `Etsy order sent to ${result.vendorKey}.`,
            provider: result.vendorKey,
            submission_response: result.response,
        });
    } catch (err) {
        return res.status(err.status || 500).json({
            message: "Retry Etsy fulfillment failed",
            error: err.message,
            hint: err.hint,
        });
    }
};

const getEtsyScaleOrderProviders = async (req, res) => {
    try {
        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) return res.status(404).json({ message: "Etsy order not found" });

        const accessError = ensureSellerCanAccessEtsyOrder(req, order);
        if (accessError) {
            return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError });
        }

        const addressInvalid = isEtsyAddressInvalid(order);
        const availableProviders = (FulfillmentService.PROVIDERS || []).map((entry) => entry.key);
        const providerOptions = (FulfillmentService.PROVIDERS || []).map((entry) => ({
            key: String(entry?.key || "").trim(),
            label: String(entry?.label || entry?.name || entry?.key || "").trim() || String(entry?.key || "").trim(),
        }));

        let matchedProviders = [];
        let reasons = [];
        try {
            const resolved = await resolveEtsyProviderFromOrder(order);
            reasons = resolved.reasons || [];
            if (resolved.providerKey && availableProviders.includes(resolved.providerKey)) {
                matchedProviders = [{ key: resolved.providerKey, label: resolved.providerKey }];
            }
        } catch (err) {
            reasons = err.providers?.length
                ? [`Multiple providers detected in order: ${err.providers.join(", ")}`]
                : [err.message].filter(Boolean);
            matchedProviders = (err.providers || [])
                .filter((key) => availableProviders.includes(key))
                .map((key) => ({ key, label: key }));
        }

        const singleAuto = matchedProviders.length === 1 ? matchedProviders[0].key : "";
        return res.json({
            orderId: order.orderId,
            scale_overall_status: order.scale_overall_status || null,
            address_invalid: addressInvalid,
            message: addressInvalid ? buildEtsyInvalidAddressMessage(order) : null,
            providers: providerOptions,
            matched_providers: matchedProviders,
            can_manual_override: providerOptions.length > 1,
            auto_provider: singleAuto || null,
            can_auto_resolve: !!singleAuto,
            reasons,
        });
    } catch (err) {
        return res.status(500).json({ message: "Get Etsy providers failed", error: err.message });
    }
};

const pushEtsyPlatformOrders = async (req, res) => {
    let orders = [];

    const orderIds = normalizeOrderIds(req.body?.orderIds);
    if (!orderIds) {
        return res.status(400).json({
            message: "orderIds must be a non-empty array",
        });
    }

    if (orderIds.length === 0) {
        return res.status(400).json({
            message: "orderIds must contain at least one valid order id",
        });
    }

    try {
        orders = await EtsyOrder.find({ orderId: { $in: orderIds } })
            .populate({ path: "shopId", select: "name" })
            .populate({ path: "case", select: "name blocksProduction" })
            .populate({ path: "seller.sellerId", select: "full_name email employee_id" });

        const foundOrderIds = new Set(orders.map((order) => order.orderId));
        const missingOrderIds = orderIds.filter((orderId) => !foundOrderIds.has(orderId));
        if (missingOrderIds.length > 0) {
            return res.status(404).json({
                message: "Some Etsy orders were not found or are not accessible",
                orderIds: missingOrderIds,
            });
        }

        const accessErrors = orders
            .map((order) => ({ orderId: order.orderId, message: ensureSellerCanAccessEtsyOrder(req, order) }))
            .filter((entry) => entry.message);
        if (accessErrors.length > 0) {
            const invalidUser = accessErrors.some((entry) => entry.message.startsWith("Invalid"));
            return res.status(invalidUser ? 400 : 403).json({
                message: accessErrors[0].message,
                orders: accessErrors,
            });
        }

        const invalidAddressOrders = orders
            .filter(isEtsyAddressInvalid)
            .map((order) => ({
                orderId: order.orderId,
                message: buildEtsyInvalidAddressMessage(order),
                address_validation: order.address_validation || null,
            }));
        if (invalidAddressOrders.length > 0) {
            return res.status(409).json({
                message: "Some Etsy orders have invalid addresses",
                orders: invalidAddressOrders,
            });
        }

        const notReadyOrders = orders
            .filter((order) => !["Ready", "Failed"].includes(order.scale_overall_status))
            .map((order) => ({
                orderId: order.orderId,
                scale_overall_status: order.scale_overall_status || null,
            }));
        if (notReadyOrders.length > 0) {
            return res.status(409).json({
                message: "Only Etsy orders with scale_overall_status Ready or Failed can be pushed to Fulfillment Platform v2",
                orders: notReadyOrders,
            });
        }

        const blockedOrders = orders
            .map((order) => ({
                orderId: order.orderId,
                cases: (Array.isArray(order.case) ? order.case : [])
                    .filter((caseDoc) => caseDoc && typeof caseDoc === "object" && caseDoc.blocksProduction === true)
                    .map((caseDoc) => ({
                        id: String(caseDoc._id || ""),
                        name: caseDoc.name || "",
                    })),
            }))
            .filter((entry) => entry.cases.length > 0);
        if (blockedOrders.length > 0) {
            return res.status(409).json({
                message: "Some Etsy orders have blocking case(s) and cannot be pushed to production",
                orders: blockedOrders,
            });
        }

        const invalidProductionOrders = orders
            .map((order) => ({
                orderId: order.orderId,
                errors: getEtsyProductionPrerequisiteErrors(order),
            }))
            .filter((entry) => entry.errors.length > 0);
        if (invalidProductionOrders.length > 0) {
            return res.status(409).json({
                message: "Some Etsy orders are missing production prerequisites",
                orders: invalidProductionOrders,
            });
        }

        const { fulfillment } = await pushEtsyOrdersToFulfillmentPlatformV2({
            orders,
            req,
        });

        return res.json({
            message: "Pushed Etsy orders to Fulfillment Platform v2",
            attemptedCount: orders.length,
            sentCount: orders.length,
            fulfillment,
        });
    } catch (err) {
        return res.status(err.status || 502).json({
            message: err.message || "Failed to push Etsy orders to Fulfillment Platform",
            attemptedCount: orderIds.length,
            fulfillment: err.fulfillment,
            errors: err.errors,
        });
    }
};

const assignEtsyOrderToCS = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { csUserId } = req.body || {};
        const assignedBy = req.user?.userId || req.user?.id || req.user?._id || null;

        if (!mongoose.Types.ObjectId.isValid(csUserId)) {
            return res.status(400).json({ message: "Invalid csUserId" });
        }

        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        const csUser = await User.findById(csUserId)
            .select("_id full_name email role_id")
            .lean();

        if (!csUser) {
            return res.status(404).json({ message: "CS user not found" });
        }

        if (!csUser.role_id || !mongoose.Types.ObjectId.isValid(csUser.role_id)) {
            return res.status(400).json({ message: "User does not have a valid role_id" });
        }

        const role = await Role.findById(csUser.role_id).select("name").lean();
        const roleName = String(role?.name || "").trim().toLowerCase();
        const allowedRoleNames = new Set([
            "customer service",
            "designer",
            "design leader",
        ]);

        if (!allowedRoleNames.has(roleName)) {
            return res.status(400).json({
                message: "Selected user must be Customer Service, Designer, or Design Leader",
                debug: {
                    userId: csUser._id,
                    role_id: csUser.role_id,
                    role_name: role?.name || null,
                },
            });
        }

        order.csAssigneeId = csUser._id;
        order.csAssignedBy = assignedBy && mongoose.Types.ObjectId.isValid(assignedBy)
            ? new mongoose.Types.ObjectId(assignedBy)
            : null;
        order.csAssignedAt = new Date();
        order.cs_assignment_status = "Assigned";

        await order.save();

        return res.json({
            message: "Assigned Etsy order to CS successfully",
            data: {
                orderId: order.orderId,
                shopId: String(order.shopId || ""),
                csAssigneeId: order.csAssigneeId,
                csAssignedBy: order.csAssignedBy,
                csAssignedAt: order.csAssignedAt,
                cs_assignment_status: order.cs_assignment_status,
                cs_assignee: {
                    _id: csUser._id,
                    full_name: csUser.full_name,
                    email: csUser.email,
                    role_name: role?.name || null,
                },
            },
        });
    } catch (err) {
        return res.status(500).json({
            message: "Assign Etsy order to CS failed",
            error: err.message,
        });
    }
};

const unassignEtsyOrderFromCS = async (req, res) => {
    try {
        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        order.csAssigneeId = null;
        order.csAssignedBy = null;
        order.csAssignedAt = null;
        order.cs_assignment_status = "Unassigned";

        await order.save();

        return res.json({
            message: "Unassigned Etsy CS successfully",
            data: {
                orderId: order.orderId,
                shopId: String(order.shopId || ""),
                cs_assignment_status: order.cs_assignment_status,
            },
        });
    } catch (err) {
        return res.status(500).json({
            message: "Unassign Etsy CS failed",
            error: err.message,
        });
    }
};

module.exports = {
    importOrders,
    getListOrders,
    computeBaseCostForEtsyOrder,
    computeMissingBaseCostsForEtsyOrders,
    updateBaseCostForEtsyOrder,
    resetBaseCostForEtsyOrder,
    getEtsyOrderStatistics,
    createOrder,
    updateSumbittedoetsyStatus,
    updateEtsyOrderAddress,
    updateEtsyOrderItemTracking,
    updateEtsyOrderTrackingForAllItems,
    getEtsyScaleList,
    getEtsyScaleStatistics,
    getEtsyQCList,
    getEtsyQCStatistics,
    uploadEtsyFulfillmentFileForItem,
    confirmEtsyScaleForItem,
    getEtsyScaleOrderProviders,
    retrySendEtsyFulfillment,
    reopenEtsyQc,
    pushEtsyPlatformOrders,
    resetEtsyScaleForOrdersBulk,
    createEtsyReplacementOrder,
    updateEtsyOrderItemQuantity,
    openCaseInEtsyOrder,
    removeCaseFromEtsyOrder,
    updateEtsyQCNoteForItem,
    updateEtsyCSNoteForItem,
    assignEtsyOrderToCS,
    unassignEtsyOrderFromCS,
    testEtsySmartyAddressValidation,
    buildEtsyTrackingSummary,
    buildEtsyTrackingInfoResponse,
    _computeMissingEtsyBaseCosts: computeMissingEtsyBaseCosts,
    _buildEtsyScalePipeline: buildEtsyScalePipeline,
};
