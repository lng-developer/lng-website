// services/fulfillment/providers/printway.js
const axios = require("axios");

/* ------------------------- Helpers ------------------------- */
function sanitizePhone(phone) {
    if (!phone) return "";
    return String(phone).replace(/\s*ext\..*$/i, "").trim();
}

function splitName(full = "") {
    const name = String(full || "").trim();
    if (!name) return { firstName: "", lastName: "" };
    const parts = name.split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: "." };
    const lastName = parts.pop();
    const firstName = parts.join(" ");
    return { firstName, lastName };
}

function pickUrl(ff, key) {
    if (!ff) return "";
    if (ff instanceof Map) {
        const v = ff.get(key);
        return v ? String(v) : "";
    }
    if (typeof ff === "object" && !Array.isArray(ff)) {
        const v = ff[key];
        return v ? String(v) : "";
    }
    if (typeof ff === "string") {
        return key === "front" ? ff : "";
    }
    return "";
}

function buildArtwork(ff = {}) {
    return {
        artwork_front: pickUrl(ff, "front"),
        artwork_back: pickUrl(ff, "back"),
        artwork_right: pickUrl(ff, "right"),
        artwork_left: pickUrl(ff, "left"),
        artwork_hood: pickUrl(ff, "hood"),
        artwork_bothsides: pickUrl(ff, "bothsides"),
        artwork_right_upper_sleeves: pickUrl(ff, "right_upper_sleeves"),
        artwork_right_lower_sleeves: pickUrl(ff, "right_lower_sleeves"),
        artwork_left_upper_sleeves: pickUrl(ff, "left_upper_sleeves"),
        artwork_left_lower_sleeves: pickUrl(ff, "left_lower_sleeves"),
        artwork_left_chest: pickUrl(ff, "left_chest"),
        artwork_right_chest: pickUrl(ff, "right_chest"),
        artwork_front_bottom_right: pickUrl(ff, "front_bottom_right"),
        artwork_center_upper_back: pickUrl(ff, "center_upper_back"),
        artwork_across_chest: pickUrl(ff, "across_chest"),
        artwork_across_back: pickUrl(ff, "across_back"),
    };
}

function buildPrintwayItem(item) {
    const ff = item.fulfillment_file || {};
    const sku =
        item?.cost_breakdown?.matchedSku || item?.mapped_sku || item?.sku || "";

    return {
        product_location: item?.cost_breakdown?.product_location || "PW",
        made_in_location: item?.cost_breakdown?.made_in_location || "VN",
        product_name: item?.cost_breakdown?.itemDisplayName || item?.title || "",
        item_sku: sku,
        variant_id: item?.variant_id || "",
        quantity: Number(item?.quantity || 1),
        variant_note: item?.qc_note || item?.cs_note || "",
        mockup_url: item?.baseImage?.imageUrl || "",
        ...buildArtwork(ff),
    };
}

function buildPayload(orderObj) {
    const customer = orderObj.customer_infor || {};
    const items = orderObj.items || [];

    const shipping_country_code = (customer.country || "US").toUpperCase();
    const shipping_country =
        shipping_country_code === "US"
            ? "United States"
            : customer.country || "United States";

    const shipping_province_code = (customer.state || "").toUpperCase();
    const shipping_province = customer.state || "";

    const { firstName, lastName } = splitName(customer.name || "");

    return {
        order_id: orderObj.orderId,
        store_code: orderObj.store_code || "",
        shipping_email: customer.email || "",
        firstName,
        lastName,
        shipping_phone: sanitizePhone(customer.phone_number),
        shipping_address1: customer.address || "",
        shipping_address2: customer.address_2 || "",
        shipping_city: customer.city || "",
        shipping_province,
        shipping_province_code,
        shipping_zip: customer.zip_code || "",
        shipping_country,
        shipping_country_code,
        shipping_service: orderObj.shipping_type || "",
        discount_code: Array.isArray(orderObj.discount_code)
            ? orderObj.discount_code
            : [],
        taxNumber: orderObj.taxNumber || customer.taxNumber || "",
        order_items: items.map(buildPrintwayItem),
    };
}

/* -------------------- Response parser ------------------- */
function parseResponseForPrintway(body) {
    const bucket = body?.result || body?.data || {};
    const status = Number(body?.status);
    const message = body?.message || "";

    if (status === 200) {
        const orderId = bucket.order_id || bucket.order_name || null;
        const itemPwMap = Array.isArray(bucket.order_items)
            ? bucket.order_items.map((it) => ({
                item_sku: it.item_sku,
                pw_id: it.pw_id,
                unfulfill_quantity:
                    it.unfulfill_quantity ?? it.quantity ?? it.qty ?? null,
            }))
            : [];

        return {
            ok: true,
            externalId: orderId,
            normalized: {
                status,
                message: message || "OK",
                order_id: orderId,
                itemPwMap,
                updated_at: bucket.updated_at || null,
            },
        };
    }

    if (status === 400) {
        const errors = (bucket?.data_error || []).map((e) => e.item_sku || e);
        const err = new Error(message || "Printway: Invalid Order Items.");
        err.code = "PRINTWAY_INVALID_ORDER_ITEMS";
        err.itemErrors = errors;
        err.vendorResponse = body;
        return { ok: false, error: err };
    }

    if (status === 401) {
        const err = new Error(message || "Printway: Not authenticated");
        err.code = "PRINTWAY_AUTH_FAILED";
        err.vendorResponse = body;
        return { ok: false, error: err };
    }

    const err = new Error(message || "Printway: Unknown error");
    err.code = "PRINTWAY_NON_SUCCESS";
    err.vendorResponse = body;
    return { ok: false, error: err };
}

/* -------------------------- Sender ------------------------- */
async function send(orderDoc) {
    const orderObj = orderDoc.toObject
        ? orderDoc.toObject({ getters: false, virtuals: false })
        : orderDoc;

    const payload = buildPayload(orderObj);
    if (!payload.order_items?.length) {
        const err = new Error("Printway: No line items to send.");
        err.code = "NO_LINE_ITEMS";
        throw err;
    }

    const endpoint =
        process.env.PRINTWAY_ENDPOINT ||
        "https://api.printway.io/cdn/api/orders/v3/create";

    const headers = {
        "Content-Type": "application/json",
        "pw-access-token": process.env.PRINTWAY_ACCESS_TOKEN,
    };

    const resp = await axios.post(endpoint, payload, { headers });
    const body = resp?.data;

    if (!body || typeof body !== "object") {
        const err = new Error("Printway: Empty or invalid JSON response");
        err.code = "PRINTWAY_INVALID_RESPONSE";
        throw err;
    }

    const parsed = parseResponseForPrintway(body);
    if (!parsed.ok) throw parsed.error;

    return {
        data: body,
        externalId: parsed.externalId,
        normalized: parsed.normalized,
    };
}

module.exports = {
    key: "printway",
    canHandle: (orderDoc) =>
        String(orderDoc.vendor || "").toLowerCase() === "printway",
    send,
};
