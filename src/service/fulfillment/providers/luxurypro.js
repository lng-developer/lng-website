// services/fulfillment/providers/luxurypro.js
const axios = require("axios");

function safeStr(value) {
    return value === undefined || value === null ? "" : String(value);
}

function isUrl(value) {
    return /^https?:\/\/\S+/i.test(String(value || "").trim());
}

function splitName(full = "") {
    const name = safeStr(full).trim();
    if (!name) return { firstName: "", lastName: "" };
    const parts = name.split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: "." };
    const lastName = parts.pop();
    return { firstName: parts.join(" "), lastName };
}

function normalizePhone(raw = "") {
    const s = safeStr(raw).trim();
    if (!s) return "";
    const noExt = s.replace(/\b(ext|extension)\b\.?\s*\d+/gi, "").trim();
    const cleaned = noExt.replace(/[^\d+\-]/g, "");
    if (!/^\+/.test(cleaned) && /^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
    return cleaned;
}

function getFulfillmentEntries(ff) {
    if (!ff) return [];
    if (ff instanceof Map) return [...ff.entries()];
    if (Array.isArray(ff)) {
        return ff
            .map((it, index) => {
                if (typeof it === "string") return [String(index), it];
                return [it?.key || it?.position || String(index), it?.url || it?.link];
            })
            .filter(([, url]) => !!url);
    }
    if (typeof ff === "object") return Object.entries(ff);
    if (typeof ff === "string") return [["front", ff]];
    return [];
}

const POSITION_MAP = {
    front: 1,
    design_front: 1,
    "front design": 1,
    back: 2,
    design_back: 2,
    "back design": 2,
    left_chest: 3,
    right_chest: 4,
    left_sleeve: 5,
    sleeve_left: 5,
    right_sleeve: 6,
    sleeve_right: 6,
    neck: 7,
};

function normalizePosition(key) {
    const raw = safeStr(key).trim();
    if (/^\d+$/.test(raw)) return Number(raw);
    const normalized = raw.toLowerCase().replace(/\s+/g, "_");
    return POSITION_MAP[normalized] || POSITION_MAP[raw.toLowerCase()] || 1;
}

function buildDesigns(item = {}) {
    if (Array.isArray(item.designs) && item.designs.length) {
        return item.designs
            .map((d) => ({
                position: Number(d?.position || 1),
                link: safeStr(d?.link || d?.url),
            }))
            .filter((d) => d.position && isUrl(d.link));
    }

    const designs = getFulfillmentEntries(item.fulfillment_file)
        .map(([key, url]) => ({
            position: normalizePosition(key),
            link: safeStr(url),
        }))
        .filter((d) => d.position && isUrl(d.link));

    if (designs.length) return designs;

    if (isUrl(item.svgFile)) return [{ position: 1, link: safeStr(item.svgFile) }];
    return [];
}

function buildMockups(item = {}) {
    if (Array.isArray(item.mockups) && item.mockups.length) {
        return item.mockups
            .map((m) => (typeof m === "string" ? m : m?.link || m?.url))
            .filter(isUrl)
            .map(String);
    }

    const mockup = item?.baseImage?.imageUrl || item?.snapshotImage || item?.image;
    return isUrl(mockup) ? [safeStr(mockup)] : [];
}

function buildLineItem(item = {}) {
    const sku = safeStr(
        item?.cost_breakdown?.matchedSku ||
        item?.mapped_sku ||
        item?.vendorVariantSku ||
        item?.sku ||
        ""
    );

    return {
        sku,
        variant_sku: sku,
        product_sku: sku,
        quantity: Number(item.quantity || 1),
        designs: buildDesigns(item),
        mockups: buildMockups(item),
        note: safeStr(item.cs_note || item.qc_note || ""),
    };
}

function mapShippingType(shippingType) {
    const value = safeStr(shippingType).trim().toLowerCase();
    if (value.includes("overnight")) return "overnight";
    if (value.includes("second")) return "second_day";
    if (value.includes("expedited") || value.includes("priority")) return "priority";
    if (value.includes("ground")) return "ground";
    return "standard";
}

function buildPayload(orderObj = {}) {
    const customer = orderObj.customer_infor || orderObj.customer || {};
    const { firstName, lastName } = splitName(customer.name || "");
    const completedItems = (orderObj.items || []).filter(
        (item) => safeStr(item.scale_status).toLowerCase() === "complete"
    );

    return {
        order_number: safeStr(orderObj.order_number || orderObj.orderNumber || orderObj.orderId || orderObj._id),
        shipping_method: mapShippingType(orderObj.shipping_type || orderObj.shippingMethod),
        first_name: safeStr(customer.first_name || customer.firstName || firstName),
        last_name: safeStr(customer.last_name || customer.lastName || lastName),
        email: safeStr(customer.email || orderObj.email || ""),
        phone: normalizePhone(customer.phone_number || customer.phone || orderObj.phone || ""),
        country_code: safeStr(customer.country_code || customer.countryCode || customer.country || "US").toUpperCase(),
        province: safeStr(customer.province || customer.state || ""),
        state: safeStr(customer.state || customer.province || ""),
        city: safeStr(customer.city || ""),
        zip: safeStr(customer.zip_code || customer.zip || ""),
        address_1: safeStr(customer.address || customer.address_1 || ""),
        address_2: safeStr(customer.address_2 || ""),
        note: safeStr(orderObj.note || orderObj.order_note || ""),
        items: completedItems.map(buildLineItem),
    };
}

function validatePayload(payload) {
    const errors = [];
    const need = (field, value) => {
        if (!safeStr(value).trim()) errors.push(`Missing ${field}`);
    };

    need("order_number", payload.order_number);
    need("first_name", payload.first_name);
    need("last_name", payload.last_name);
    need("country_code", payload.country_code);
    need("city", payload.city);
    need("zip", payload.zip);
    need("address_1", payload.address_1);

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        errors.push("Missing items (no completed items found)");
    } else {
        payload.items.forEach((item, index) => {
            need(`items[${index}].sku`, item.sku);
            if (!(Number(item.quantity) > 0)) {
                errors.push(`items[${index}].quantity must be > 0`);
            }
            if (!Array.isArray(item.designs) || item.designs.length === 0) {
                errors.push(`items[${index}] missing designs`);
            }
        });
    }

    return { ok: errors.length === 0, errors };
}

function parseExternalId(body = {}) {
    const data = body.data || body.result || {};
    return (
        data.id ||
        data.order_id ||
        data.orderId ||
        data.order_number ||
        body.id ||
        body.order_id ||
        body.orderId ||
        body.order_number ||
        null
    );
}

function assertAccepted(body) {
    if (!body || typeof body !== "object") {
        const err = new Error("LuxuryPro: Empty or invalid JSON response");
        err.code = "LUXURYPRO_INVALID_RESPONSE";
        throw err;
    }

    const success = body.success;
    const status = safeStr(body.status || body.code).toLowerCase();
    const message = safeStr(body.message || body.error || "");
    const failed =
        success === false ||
        ["error", "failed", "fail", "rejected"].includes(status) ||
        !!body.errors;

    if (failed) {
        const err = new Error(`LuxuryPro rejected order: ${message || "Unknown error"}`);
        err.code = "LUXURYPRO_REJECTED";
        err.vendorResponse = body;
        throw err;
    }
}

async function send(orderDoc) {
    const orderObj = orderDoc?.toObject
        ? orderDoc.toObject({ getters: false, virtuals: false })
        : orderDoc;

    const payload = buildPayload(orderObj);
    const pre = validatePayload(payload);
    if (!pre.ok) {
        const err = new Error(`LuxuryPro payload validation failed: ${pre.errors.join("; ")}`);
        err.code = "LUXURYPRO_PREVALIDATION_FAILED";
        err.details = pre.errors;
        err.payload = payload;
        throw err;
    }

    const endpoint =
        process.env.LUXURYPRO_ENDPOINT ||
        process.env.LUXURYPRO_CREATE_ORDER_ENDPOINT ||
        "https://api.lenauto.com/api/luxurypro/create";

    const apiKey = process.env.LUXURYPRO_API_KEY || process.env.LUXURYPRO_ACCESS_TOKEN;
    if (!apiKey) {
        const err = new Error("Missing LUXURYPRO_API_KEY in environment");
        err.code = "LUXURYPRO_MISSING_API_KEY";
        throw err;
    }

    const authMode = safeStr(process.env.LUXURYPRO_AUTH_MODE || "bearer").toLowerCase();
    const headers = { "Content-Type": "application/json" };
    if (authMode === "x-api-key") headers["X-API-Key"] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;

    console.log("[LUXURYPRO] Create order endpoint:", endpoint);
    console.log("[LUXURYPRO] Sending payload:", JSON.stringify(payload, null, 2));

    let body;
    try {
        const resp = await axios.post(endpoint, payload, { headers });
        body = resp?.data;
    } catch (e) {
        const status = e?.response?.status;
        const data = e?.response?.data;
        const msg = data?.message || data?.error || e.message;
        const err = new Error(`LuxuryPro HTTP ${status || "unknown"}: ${msg}`);
        err.code = "LUXURYPRO_HTTP_ERROR";
        err.vendorResponse = data;
        err.payload = payload;
        throw err;
    }

    assertAccepted(body);

    return {
        data: body,
        externalId: parseExternalId(body),
    };
}

module.exports = {
    key: "luxurypro",
    canHandle: (orderDoc) => String(orderDoc.vendor || "").toLowerCase() === "luxurypro",
    send,
    _helpers: {
        buildPayload,
        buildLineItem,
        buildDesigns,
        buildMockups,
        validatePayload,
        parseExternalId,
    },
};
