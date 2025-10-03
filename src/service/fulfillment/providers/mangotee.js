// services/fulfillment/providers/mangotee.js
const axios = require("axios");

/* -------------------- Helpers -------------------- */
function splitName(full = "") {
    const name = String(full || "").trim();
    if (!name) return { firstName: "", lastName: "" };
    const parts = name.split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: "." };
    const lastName = parts.pop();
    const firstName = parts.join(" ");
    return { firstName, lastName };
}

function normalizePhone(raw = "") {
    const s = String(raw || "").trim();
    if (!s) return "";
    const cleaned = s.replace(/[^\d+\-]/g, "");
    if (!/^\+/.test(cleaned) && /^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
    return cleaned;
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

function mapShippingMethod(orderObj = {}) {
    const raw =
        orderObj.shipping_method ||
        orderObj.shippingMethod ||
        orderObj.shipping_type ||
        orderObj.shippingService ||
        "";

    const s = String(raw || "").toLowerCase().trim();
    if (/^standard|economy|ground$/.test(s)) return "standard";
    if (/^expedited|express|priority|2d|two/.test(s)) return "expedited";
    if (/^overnight|next/.test(s)) return "overnight";
    return "standard";
}

function detectFacility(orderObj = {}, item = {}) {
    return (
        item?.cost_breakdown?.product_location ||
        orderObj.facility ||
        process.env.MANGOTEE_DEFAULT_FACILITY ||
        "TX"
    );
}

function buildPreviewFiles(item = {}) {
    const out = [];
    const mock = item?.baseImage?.imageUrl || item?.mockup_url || "";
    if (mock) out.push({ key: "front", url: String(mock) });

    const ff = item.fulfillment_file || {};
    const keys = [
        "front",
        "back",
        "right",
        "left",
        "hood",
        "bothsides",
        "right_upper_sleeves",
        "right_lower_sleeves",
        "left_upper_sleeves",
        "left_lower_sleeves",
        "left_chest",
        "right_chest",
        "front_bottom_right",
        "center_upper_back",
        "across_chest",
        "across_back",
    ];
    keys.forEach((k) => {
        const u = pickUrl(ff, k);
        if (u) out.push({ key: k, url: u });
    });

    return out;
}

function buildPrintFiles(item = {}) {
    const out = [];
    const ff = item.fulfillment_file || {};
    const keys = ["front", "back", "right", "left", "hood", "bothsides"];
    keys.forEach((k) => {
        const u = pickUrl(ff, k);
        if (u) out.push({ key: k, url: u });
    });
    if (out.length === 0) {
        const mock = item?.baseImage?.imageUrl || item?.mockup_url || "";
        if (mock) out.push({ key: "front", url: String(mock) });
    }
    return out;
}

function buildInserts(orderObj = {}) {
    const inserts = [];
    const packing = orderObj.packing_slip_url || orderObj.packingSlipUrl || "";
    if (packing) {
        inserts.push({
            name: "packing_slip",
            size: "8.5x11",
            url: String(packing),
        });
    }
    return inserts;
}

function buildMangoItem(item = {}, orderObj = {}) {
    const sku =
        item?.cost_breakdown?.matchedSku || item?.mapped_sku || item?.sku || "";

    return {
        sku,
        quantity: Number(item?.quantity || 1),
        production_config: item?.production_config || "default",
        facility: detectFacility(orderObj, item),
        preview_files: buildPreviewFiles(item),
        print_files: buildPrintFiles(item),
        inserts: buildInserts(orderObj),
    };
}

function buildPayload(orderObj = {}) {
    const customer = orderObj.customer_infor || {};
    const items = Array.isArray(orderObj.items) ? orderObj.items : [];

    const { firstName, lastName } = splitName(customer.name || "");

    return {
        order_id: orderObj.orderId || orderObj.order_id || "",
        seller: orderObj.seller || orderObj.sellerCode || "",
        user_id: orderObj.user_id || orderObj.userId || "",
        shipping_method: mapShippingMethod(orderObj),
        email: customer.email || "",
        phone: normalizePhone(customer.phone || customer.phone_number || ""),
        first_name: firstName,
        last_name: lastName,
        address_line_1: customer.address || "",
        address_line_2: customer.address_2 || "",
        city: customer.city || "",
        state: customer.state || "",
        zip: customer.zip_code || customer.zip || "",
        country: customer.country_full || customer.country || "United States",
        label_url:
            orderObj.label_url ||
            orderObj.labelUrl ||
            orderObj.shipping_label_url ||
            "",
        note: orderObj.note || orderObj.order_note || "",
        items: items.map((it) => buildMangoItem(it, orderObj)),
    };
}

/* -------------------- Response parser ------------------- */
function parseResponseForMangoTee(body) {
    const pickExternalId = (b = {}) => {
        const d = b.data || {};
        return (
            d.order_id ||
            d.id ||
            d.external_id ||
            b.order_id ||
            b.id ||
            b.external_id ||
            null
        );
    };

    const msg = String(body?.message || "").trim();
    const msgLower = msg.toLowerCase();
    const bucket = body?.data || body?.result || body || {};
    const statusNum = Number(body?.status || bucket?.status);

    // 1) clear success flag
    if (typeof body?.success === "boolean") {
        if (body.success) {
            return {
                ok: true,
                externalId: pickExternalId(body),
                normalized: { success: true, message: msg || "OK", data: body.data || body },
            };
        }
        const err = new Error(msg || "MangoTee: Non-success response");
        err.code = "MANGOTEE_NON_SUCCESS";
        err.vendorResponse = body;
        return { ok: false, error: err };
    }

    // 2) numeric status
    if (!Number.isNaN(statusNum)) {
        if (statusNum >= 200 && statusNum < 300) {
            return {
                ok: true,
                externalId: pickExternalId(body),
                normalized: { status: statusNum, message: msg || "OK", data: bucket },
            };
        }
        // Non-2xx nhưng message cho thấy idempotent success
        if (
            msgLower.includes("created successfully") ||
            msgLower.includes("order created") ||
            msgLower.includes("already exist") ||
            msgLower.includes("already created") ||
            msgLower.includes("success")
        ) {
            return {
                ok: true,
                externalId: pickExternalId(body),
                normalized: {
                    status: statusNum,
                    message: msg || "OK (soft-success)",
                    data: bucket,
                    soft: true,
                },
            };
        }
        const err = new Error(msg || "MangoTee: Error");
        err.code = "MANGOTEE_NON_SUCCESS";
        err.vendorResponse = body;
        return { ok: false, error: err };
    }

    // 3) Không có success/status nhưng message là success
    if (
        msgLower.includes("created successfully") ||
        msgLower.includes("order created") ||
        msgLower.includes("success")
    ) {
        return {
            ok: true,
            externalId: pickExternalId(body),
            normalized: { message: msg || "OK", data: bucket, soft: true },
        };
    }

    // 4) raw fields
    if (body && (body.id || body.order_id)) {
        return {
            ok: true,
            externalId: body.order_id || body.id || null,
            normalized: { data: body },
        };
    }

    const err = new Error("MangoTee: Unknown/invalid response");
    err.code = "MANGOTEE_INVALID_RESPONSE";
    err.vendorResponse = body;
    return { ok: false, error: err };
}

/* -------------------------- Sender ------------------------- */
async function send(orderDoc) {
    const orderObj = orderDoc?.toObject
        ? orderDoc.toObject({ getters: false, virtuals: false })
        : orderDoc;

    const payload = buildPayload(orderObj);
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        const err = new Error("MangoTee: No line items to send.");
        err.code = "NO_LINE_ITEMS";
        throw err;
    }

    const endpoint =
        process.env.MANGOTEE_ENDPOINT ||
        "https://v3.mangoteeprints.com/api/public/v1/orders";

    const apiKey =
        process.env.MANGOTEE_API_KEY || process.env.MANGOTEE_ACCESS_TOKEN || "";

    if (!apiKey) {
        const err = new Error("Missing MANGOTEE_API_KEY in environment");
        err.code = "MANGOTEE_MISSING_API_KEY";
        throw err;
    }

    const headers = {
        "Content-Type": "application/json",
        "X-API-Key": apiKey, // chỉ header này
    };

    console.log("[MANGOTEE] Create order endpoint:", endpoint);
    console.log("[MANGOTEE] Sending payload:", JSON.stringify(payload, null, 2));

    let body;
    try {
        const resp = await axios.post(endpoint, payload, { headers });
        body = resp?.data;
    } catch (e) {
        // Nếu vendor trả non-2xx nhưng message nói đã tạo thành công/idempotent
        const data = e?.response?.data;
        const msg = String(data?.message || e.message || "").toLowerCase();
        const looksLikeSuccess =
            msg.includes("created successfully") ||
            msg.includes("order created") ||
            msg.includes("already exist") ||
            msg.includes("already created") ||
            msg.includes("success");

        if (looksLikeSuccess && data) {
            const parsedSoft = parseResponseForMangoTee(data);
            if (parsedSoft.ok) {
                return {
                    data,
                    externalId: parsedSoft.externalId,
                    normalized: parsedSoft.normalized,
                };
            }
        }
        // ném lại lỗi thật sự
        throw e;
    }

    if (!body || typeof body !== "object") {
        const err = new Error("MangoTee: Empty or invalid JSON response");
        err.code = "MANGOTEE_INVALID_RESPONSE";
        throw err;
    }

    const parsed = parseResponseForMangoTee(body);
    if (!parsed.ok) throw parsed.error;

    return {
        data: body,
        externalId: parsed.externalId,
        normalized: parsed.normalized,
    };
}

module.exports = {
    key: "mangotee",
    canHandle: (orderDoc) =>
        String(orderDoc.vendor || "").toLowerCase() === "mangotee",
    send,
};
