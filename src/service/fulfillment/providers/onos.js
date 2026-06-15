// services/fulfillment/providers/onos.js
const axios = require("axios");

function safeStr(value) {
    return value === undefined || value === null ? "" : String(value);
}

function isUrl(value) {
    return /^https?:\/\/\S+/i.test(safeStr(value).trim());
}

function normalizePhone(raw = "") {
    const s = safeStr(raw).trim();
    if (!s) return "";
    return s.replace(/\s+/g, " ");
}

function getFulfillmentEntries(ff) {
    if (!ff) return [];
    if (ff instanceof Map) return [...ff.entries()];
    if (Array.isArray(ff)) {
        return ff
            .map((it, index) => {
                if (typeof it === "string") return [String(index), it];
                return [it?.key || it?.position || String(index), it?.url || it?.link || it?.value];
            })
            .filter(([, url]) => !!url);
    }
    if (typeof ff === "object") return Object.entries(ff);
    if (typeof ff === "string") return [["front", ff]];
    return [];
}

const PRINT_AREA_KEY_MAP = {
    front: "front",
    design_front: "front",
    back: "back",
    design_back: "back",
    hood: "hood",
    design_hood: "hood",
    sleeve: "sleeve",
    design_sleeve: "sleeve",
    left_sleeve: "sleeve_left",
    sleeve_left: "sleeve_left",
    right_sleeve: "sleeve_right",
    sleeve_right: "sleeve_right",
    chest_left: "chest_left",
    left_chest: "chest_left",
    design_chest_left: "chest_left",
    chest_right: "chest_right",
    right_chest: "chest_right",
    design_chest_right: "chest_right",
    upper_sleeve_left: "upper_sleeve_left",
    left_upper_sleeve: "upper_sleeve_left",
    left_upper_sleeves: "upper_sleeve_left",
    upper_sleeve_right: "upper_sleeve_right",
    right_upper_sleeve: "upper_sleeve_right",
    right_upper_sleeves: "upper_sleeve_right",
};

function normalizePrintAreaKey(key) {
    const raw = safeStr(key).trim();
    if (!raw) return "";
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
    return PRINT_AREA_KEY_MAP[normalized] || normalized;
}

function buildPrintAreas(item = {}) {
    if (Array.isArray(item.print_areas) && item.print_areas.length) {
        return item.print_areas
            .map((area) => ({
                key: normalizePrintAreaKey(area?.key),
                value: safeStr(area?.value || area?.url || area?.link),
            }))
            .filter((area) => area.key && isUrl(area.value));
    }

    return getFulfillmentEntries(item.fulfillment_file)
        .map(([key, value]) => ({
            key: normalizePrintAreaKey(key),
            value: safeStr(value),
        }))
        .filter((area) => area.key && isUrl(area.value));
}

function getProductName(item = {}) {
    return safeStr(
        item?.cost_breakdown?.itemDisplayName ||
        item?.product_name ||
        item?.title ||
        item?.name ||
        ""
    );
}

function getProductId(item = {}) {
    return safeStr(
        item?.cost_breakdown?.productId ||
        item?.vendor_product_id ||
        item?.product_id ||
        item?.asin ||
        item?.sku ||
        ""
    );
}

function getSku(item = {}) {
    return safeStr(
        item?.cost_breakdown?.matchedSku ||
        item?.mapped_sku ||
        item?.vendorVariantSku ||
        item?.sku ||
        ""
    );
}

function buildAttributes(item = {}) {
    const attrs = [];
    const product = getProductName(item);
    const color = safeStr(
        item?.cost_breakdown?.colorValue ||
        item?.color ||
        item?.variant_color ||
        "As Design"
    );
    const size = safeStr(
        item?.cost_breakdown?.sizeValue ||
        item?.size ||
        item?.variant_size ||
        ""
    );

    if (product) attrs.push({ name: "product", option: product });
    if (color) attrs.push({ name: "Color", option: color });
    if (size) attrs.push({ name: "Size", option: size });

    const sku = getSku(item);
    if (sku) attrs.push({ name: "Sku", option: sku });
    return attrs;
}

function buildLineItem(item = {}) {
    const printAreas = buildPrintAreas(item);

    return {
        attributes: buildAttributes(item),
        currency: safeStr(item.currency || item?.cost_breakdown?.currency || "USD") || "USD",
        print_areas: printAreas,
        image: safeStr(item?.baseImage?.imageUrl || item?.mockup_url || item?.image || ""),
        name: getProductName(item),
        price: Number(item?.cost_breakdown?.base_cost_each || item?.price || 0),
        product_id: getProductId(item),
        quantity: Number(item.quantity || 1),
        sku: getSku(item),
    };
}

function mapShippingMethod(orderObj = {}) {
    const raw = safeStr(orderObj.shipping_method || orderObj.shipping_type || "").toLowerCase();
    const configuredDefault = safeStr(process.env.ONOS_SHIPPING_METHOD_DEFAULT || "").toUpperCase();
    if (["ONOSEXPRESS", "SBTT", "COD"].includes(configuredDefault)) return configuredDefault;
    if (raw.includes("cod")) return "COD";
    if (raw.includes("tiktok") || raw.includes("sbtt")) return "SBTT";
    return "ONOSEXPRESS";
}

function buildPayload(orderObj = {}) {
    const customer = orderObj.customer_infor || orderObj.customer || {};
    const completedItems = (orderObj.items || []).filter(
        (item) => safeStr(item.scale_status).toLowerCase() === "complete"
    );

    return {
        order_id: safeStr(orderObj.orderId || orderObj.order_id || orderObj._id),
        referent_id: safeStr(orderObj.referent_id || orderObj.reference_id || orderObj.orderId || ""),
        identifier: safeStr(orderObj.identifier || orderObj.marketplace || "API") || "API",
        customer_note: safeStr(orderObj.customer_note || orderObj.customerNote || ""),
        items: completedItems.map(buildLineItem),
        note: safeStr(orderObj.note || orderObj.cs_note || ""),
        order_name: safeStr(orderObj.order_name || orderObj.orderName || ""),
        reference_id: safeStr(orderObj.reference_id || orderObj.amazon_order_id || orderObj.orderId || ""),
        shipping_info: {
            full_name: safeStr(customer.full_name || customer.name || ""),
            address_1: safeStr(customer.address_1 || customer.address || ""),
            address_2: safeStr(customer.address_2 || ""),
            city: safeStr(customer.city || ""),
            country: safeStr(customer.country_code || "US").toUpperCase(),
            email: safeStr(customer.email || ""),
            phone: normalizePhone(customer.phone_number || customer.phone || ""),
            postcode: safeStr(customer.postcode || customer.zip_code || customer.zip || ""),
            state: safeStr(customer.state || customer.province || ""),
        },
        shipping_method: mapShippingMethod(orderObj),
        inc_active_service: String(process.env.ONOS_INC_ACTIVE_SERVICE || "false").toLowerCase() === "true",
    };
}

function validatePayload(payload) {
    const errors = [];
    const need = (field, value) => {
        if (!safeStr(value).trim()) errors.push(`Missing ${field}`);
    };

    need("order_id", payload.order_id);
    need("shipping_info.full_name", payload.shipping_info?.full_name);
    need("shipping_info.address_1", payload.shipping_info?.address_1);
    need("shipping_info.city", payload.shipping_info?.city);
    need("shipping_info.country", payload.shipping_info?.country);
    need("shipping_info.postcode", payload.shipping_info?.postcode);
    need("shipping_info.state", payload.shipping_info?.state);

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        errors.push("Missing items (no completed items found)");
    } else {
        payload.items.forEach((item, index) => {
            need(`items[${index}].name`, item.name);
            need(`items[${index}].product_id`, item.product_id);
            need(`items[${index}].sku`, item.sku);
            if (!(Number(item.quantity) > 0)) errors.push(`items[${index}].quantity must be > 0`);
            if (!Array.isArray(item.attributes) || item.attributes.length === 0) {
                errors.push(`items[${index}] missing attributes`);
            }
            if (!Array.isArray(item.print_areas) || item.print_areas.length === 0) {
                errors.push(`items[${index}] missing print_areas`);
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
        data.fulfillment_id ||
        body.id ||
        body.order_id ||
        body.orderId ||
        null
    );
}

function assertAccepted(body) {
    if (!body || typeof body !== "object") {
        const err = new Error("Onos: Empty or invalid JSON response");
        err.code = "ONOS_INVALID_RESPONSE";
        throw err;
    }

    const status = body.status;
    const state = safeStr(body.status || body.code).toLowerCase();
    const message = safeStr(body.message || body.error || "");
    const failed =
        status === false ||
        ["error", "failed", "fail", "rejected"].includes(state) ||
        !!body.error ||
        !!body.errors;

    if (failed) {
        const err = new Error(`Onos rejected order: ${message || "Unknown error"}`);
        err.code = "ONOS_REJECTED";
        err.vendorResponse = body;
        throw err;
    }
}

function assertSafeEndpointForEnvironment(endpoint) {
    const env = safeStr(process.env.NODE_ENV).trim().toLowerCase();
    const allowProductionEndpointInTest =
        safeStr(process.env.ONOS_ALLOW_PRODUCTION_ENDPOINT_IN_TEST).trim().toLowerCase() === "true";

    if (env === "test" && !allowProductionEndpointInTest && !safeStr(endpoint).includes("/order/create/test")) {
        const err = new Error(
            "Refusing to send Onos order from NODE_ENV=test because ONOS_CREATE_ORDER_ENDPOINT is not /order/create/test"
        );
        err.code = "ONOS_UNSAFE_TEST_ENDPOINT";
        err.endpoint = endpoint;
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
        const err = new Error(`Onos payload validation failed: ${pre.errors.join("; ")}`);
        err.code = "ONOS_PREVALIDATION_FAILED";
        err.details = pre.errors;
        err.payload = payload;
        throw err;
    }

    const baseUrl = safeStr(process.env.ONOS_API_BASE_URL || "https://api-app.onospod.com/api/v1").replace(/\/+$/, "");
    const endpoint = process.env.ONOS_CREATE_ORDER_ENDPOINT || `${baseUrl}/order/create`;
    assertSafeEndpointForEnvironment(endpoint);

    const apiKey = process.env.ONOS_API_KEY || process.env.ONOS_ACCESS_TOKEN;
    if (!apiKey) {
        const err = new Error("Missing ONOS_API_KEY in environment");
        err.code = "ONOS_MISSING_API_KEY";
        throw err;
    }

    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
    };

    console.log("[ONOS] Create order endpoint:", endpoint);
    console.log("[ONOS] Sending order:", payload.order_id, "items:", payload.items.length);

    let body;
    try {
        const resp = await axios.post(endpoint, payload, { headers });
        body = resp?.data;
    } catch (e) {
        const status = e?.response?.status;
        const data = e?.response?.data;
        const msg = data?.message || data?.error || e.message;
        const err = new Error(`Onos HTTP ${status || "unknown"}: ${msg}`);
        err.code = "ONOS_HTTP_ERROR";
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
    key: "onos",
    canHandle: (orderDoc) => String(orderDoc.vendor || "").toLowerCase() === "onos",
    send,
    _helpers: {
        buildPayload,
        buildLineItem,
        buildPrintAreas,
        validatePayload,
        parseExternalId,
    },
};
