// services/fulfillment/providers/printway.js
const axios = require("axios");

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
    const front = pickUrl(ff, "front");
    const back = pickUrl(ff, "back");

    const right =
        pickUrl(ff, "right") ||
        pickUrl(ff, "right_sleeve") ||
        pickUrl(ff, "rightSleeve");

    const left =
        pickUrl(ff, "left") ||
        pickUrl(ff, "left_sleeve") ||
        pickUrl(ff, "leftSleeve");

    return {
        artwork_front: front,
        artwork_back: back,
        artwork_right: right,
        artwork_left: left,
        artwork_hood: pickUrl(ff, "hood"),
        artwork_bothsides: pickUrl(ff, "bothsides"),
        artwork_right_upper_sleeves:
            pickUrl(ff, "right_upper_sleeves") || pickUrl(ff, "right_upper_sleeve"),
        artwork_right_lower_sleeves:
            pickUrl(ff, "right_lower_sleeves") || pickUrl(ff, "right_lower_sleeve"),
        artwork_left_upper_sleeves:
            pickUrl(ff, "left_upper_sleeves") || pickUrl(ff, "left_upper_sleeve"),
        artwork_left_lower_sleeves:
            pickUrl(ff, "left_lower_sleeves") || pickUrl(ff, "left_lower_sleeve"),
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
        //product_location: item?.cost_breakdown?.product_location || "PW",
       // made_in_location: item?.cost_breakdown?.made_in_location,
        product_name: item?.cost_breakdown?.itemDisplayName || item?.title || "",
        item_sku: sku,
        variant_id: item?.variant_id || "",
        quantity: Number(item?.quantity || 1),
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
        lastName: `${lastName}...`,
        shipping_address1: customer.address || "",
        shipping_address2: customer.address_2 || "",
        shipping_city: customer.city || "",
        shipping_province,
        shipping_province_code,
        shipping_zip: customer.zip_code || "",
        shipping_country,
        shipping_country_code,
        discount_code: Array.isArray(orderObj.discount_code)
            ? orderObj.discount_code
            : [],
        taxNumber: orderObj.taxNumber || customer.taxNumber || "",
        order_items: items.map(buildPrintwayItem),
    };
}

/* -------------------- Response parser ------------------- */
/**
 * Hỗ trợ cả schema cũ ({status, message, result}) và schema mới bạn vừa gửi ({success, data, message})
 * Trả về:
 *  - ok, externalId (pwOrderId nếu có hoặc order_id), normalized
 */
function parseResponseForPrintway(body) {
    // New schema: { success: true/false, data:{ pwOrderId, ... }, message }
    if (typeof body?.success === "boolean") {
        if (body.success === true) {
            const d = body.data || {};
            const pwOrderId = d.pwOrderId || d.pw_order_id || null;
            const orderId = d.orderId || d.order_id || null;
            return {
                ok: true,
                externalId: pwOrderId || orderId,
                normalized: {
                    success: true,
                    message: body.message || "OK",
                    pwOrderId,
                    orderId,
                    data: d,
                },
            };
        }
        const err = new Error(body?.message || "Printway: Non-success response");
        err.code = "PRINTWAY_NON_SUCCESS";
        err.vendorResponse = body;
        return { ok: false, error: err };
    }

    // Legacy schema: { status, message, result/data }
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

/* -------------------- Auto-pay helper ------------------- */
async function payOrder(pwOrderId, baseHeaders = {}, paidEndpointFromEnv) {
    if (!pwOrderId) {
        const err = new Error("Missing pwOrderId for payment");
        err.code = "PRINTWAY_PAY_MISSING_ID";
        throw err;
    }

    const endpoint =
        paidEndpointFromEnv ||
        process.env.PRINTWAY_PAID_ENDPOINT ||
        "https://api.printway.io/cdn/api/orders/v3/order/paid";

    const body = { order_id: pwOrderId };
    const headers = {
        "Content-Type": "application/json",
        ...baseHeaders,
    };

    console.log(
        "[PRINTWAY] Auto pay request:",
        endpoint,
        JSON.stringify(body, null, 2)
    );

    const resp = await axios.post(endpoint, body, { headers });
    const data = resp?.data;

    // Kỳ vọng success:true
    if (!data || data.success !== true) {
        const err = new Error(
            (data && data.message) || "Printway: Payment failed"
        );
        err.code = "PRINTWAY_PAY_FAILED";
        err.vendorResponse = data;
        throw err;
    }
    console.log("[PRINTWAY] Auto pay success:", JSON.stringify(data, null, 2));
    return data;
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

    const createEndpoint =
        process.env.PRINTWAY_ENDPOINT ||
        "https://api.printway.io/cdn/api/orders/v3/create";

    const headers = {
        "Content-Type": "application/json",
        "pw-access-token": process.env.PRINTWAY_ACCESS_TOKEN,
    };

    // Log đầy đủ
    console.log("[PRINTWAY] Create order endpoint:", createEndpoint);
    console.log("[PRINTWAY] Sending payload:", JSON.stringify(payload, null, 2));

    // Create order
    const resp = await axios.post(createEndpoint, payload, { headers });
    const body = resp?.data;

    if (!body || typeof body !== "object") {
        const err = new Error("Printway: Empty or invalid JSON response");
        err.code = "PRINTWAY_INVALID_RESPONSE";
        throw err;
    }

    const parsed = parseResponseForPrintway(body);
    if (!parsed.ok) throw parsed.error;

    // Lấy pwOrderId từ normalized (schema mới)
    const pwOrderId =
        parsed.normalized?.pwOrderId ||
        parsed.externalId || // fallback
        null;

    // --- Auto Pay ngay sau khi tạo đơn thành công ---
    const autoPay = String(process.env.PRINTWAY_AUTO_PAY || "true").toLowerCase() !== "false";
    const payStrict = String(process.env.PRINTWAY_PAY_STRICT || "true").toLowerCase() !== "false";

    let payResult = null;
    if (autoPay) {
        try {
            payResult = await payOrder(
                pwOrderId,
                headers,
                process.env.PRINTWAY_PAID_ENDPOINT
            );
        } catch (e) {
            console.error("[PRINTWAY] Auto pay failed:", e?.message, e?.vendorResponse || "");
            if (payStrict) {
                // Nếu bạn muốn thất bại cả quy trình khi thanh toán lỗi (mặc định)
                e.code = e.code || "PRINTWAY_PAY_FAILED";
                throw e;
            }
            // Nếu không strict, chỉ gắn cảnh báo trong normalized
        }
    }

    return {
        data: body,
        externalId: parsed.externalId,
        normalized: {
            ...parsed.normalized,
            autoPay: autoPay,
            payStrict: payStrict,
            payResult: payResult || null,
        },
    };
}

module.exports = {
    key: "printway",
    canHandle: (orderDoc) =>
        String(orderDoc.vendor || "").toLowerCase() === "printway",
    send,
};
