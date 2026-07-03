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

/* -------------------- Key whitelist (theo spec Mango) -------------------- */
const ALLOWED_PRINT_KEYS = new Set([
    "front", "back", "right_sleeve", "left_sleeve", "neck_label", "right_wrist", "left_wrist",
    "center_chest", "right_chest", "left_chest", "right_cuff", "left_cuff", "collar",
    "left_slit", "right_slit", "sock_collar", "center_hat", "left_hat", "right_hat", "back_hat",
]);

// Alias nội bộ -> key Mango
const FF_KEY_MAP = {
    // chuẩn
    front: "front",
    back: "back",
    right_sleeve: "right_sleeve",
    left_sleeve: "left_sleeve",
    neck_label: "neck_label",
    right_wrist: "right_wrist",
    left_wrist: "left_wrist",
    center_chest: "center_chest",
    right_chest: "right_chest",
    left_chest: "left_chest",
    right_cuff: "right_cuff",
    left_cuff: "left_cuff",
    collar: "collar",
    left_slit: "left_slit",
    right_slit: "right_slit",
    sock_collar: "sock_collar",
    center_hat: "center_hat",
    left_hat: "left_hat",
    right_hat: "right_hat",
    back_hat: "back_hat",

    // alias phổ biến
    rightSleeve: "right_sleeve",
    leftSleeve: "left_sleeve",
    // key cũ trong hệ thống
    right_upper_sleeves: "right_sleeve",
    right_lower_sleeves: "right_sleeve",
    left_upper_sleeves: "left_sleeve",
    left_lower_sleeves: "left_sleeve",
};

function dedupeByKeyUrl(arr) {
    const seen = new Set();
    return arr.filter(({ key, url }) => {
        const k = `${key}|${url}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/** Chuẩn hoá 1 cặp (key,url) về key hợp lệ Mango và lọc theo whitelist */
function normalizePair(rawKey, url) {
    if (!url) return null;
    const mapped = FF_KEY_MAP[rawKey] || rawKey;
    if (!ALLOWED_PRINT_KEYS.has(mapped)) return null;
    return { key: mapped, url: String(url) };
}

/** Thu gom file từ fulfillment_file: hỗ trợ Map / Object / Array([{key,url}]) */
function collectFromFulfillmentFile(ff) {
    const out = [];

    if (!ff) return out;

    // Array dạng [{key,url}]
    if (Array.isArray(ff)) {
        ff.forEach(it => {
            const k = it?.key; const u = it?.url;
            const pair = normalizePair(k, u);
            if (pair) out.push(pair);
        });
        return dedupeByKeyUrl(out);
    }

    // Map (Mongoose Map)
    if (ff instanceof Map) {
        ff.forEach((v, k) => {
            const pair = normalizePair(k, v);
            if (pair) out.push(pair);
        });
        return dedupeByKeyUrl(out);
    }

    // Plain object
    if (typeof ff === "object") {
        Object.keys(ff).forEach(k => {
            const pair = normalizePair(k, ff[k]);
            if (pair) out.push(pair);
        });
        return dedupeByKeyUrl(out);
    }

    return out;
}

/** Lấy print/preview đã có sẵn nếu upstream truyền đúng schema [{key,url}] */
function collectFromArray(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    arr.forEach(it => {
        const pair = normalizePair(it?.key, it?.url);
        if (pair) out.push(pair);
    });
    return dedupeByKeyUrl(out);
}

function mapShippingMethod(orderObj = {}) {
    const raw =
        orderObj.shipping_method ||
        orderObj.shippingMethod ||
        orderObj.shipping_type ||
        orderObj.shippingService ||
        "";

    const s = String(raw || "").toLowerCase().trim();
    if (/^(standard|freeeconomy|ground)$/.test(s)) return "standard";
    if (/^(expedited|express|priority|2d|two)/.test(s)) return "priority";
    if (/^(overnight|next)/.test(s)) return "overnight";
    return "standard";
}

function normalizePreferredCarrier(raw = "") {
    const value = String(raw || "").toLowerCase().trim();
    if (!value) return "";
    if (value === "auto" || value === "usps") return value;
    return "";
}

function isUSCountry(country = "") {
    const value = String(country || "").toLowerCase().trim();
    return value === "us" || value === "usa" || value === "united states" || value === "united states of america";
}

function resolvePreferredCarrier(orderObj = {}, payload = {}) {
    const explicit = normalizePreferredCarrier(
        orderObj.preferred_carrier ||
        orderObj.preferredCarrier ||
        orderObj.shipping_preferred_carrier ||
        orderObj.shippingPreferredCarrier ||
        process.env.MANGOTEE_PREFERRED_CARRIER ||
        ""
    );
    if (explicit) return explicit;

    const isRequired =
        payload.shipping_method === "standard" &&
        isUSCountry(payload.country) &&
        !String(payload.label_url || "").trim();

    return isRequired ? "auto" : "";
}

function buildPreviewFiles(item = {}) {
    // 1) nếu upstream có sẵn preview_files hợp lệ thì dùng luôn
    const preProvided = collectFromArray(item.preview_files);
    const out = [...preProvided];

    // 2) thêm mock (front) nếu có
    const mock = item?.baseImage?.imageUrl || item?.mockup_url || "";
    if (mock) out.unshift({ key: "front", url: String(mock) });

    // 3) merge từ fulfillment_file
    const fromFF = collectFromFulfillmentFile(item.fulfillment_file);
    return dedupeByKeyUrl(out.concat(fromFF));
}

function buildPrintFiles(item = {}) {
    // Ưu tiên: nếu upstream đã cung cấp print_files hợp lệ
    const preProvided = collectFromArray(item.print_files);
    if (preProvided.length) return preProvided;

    // Sau đó: lấy từ fulfillment_file (Map/Object/Array)
    const fromFF = collectFromFulfillmentFile(item.fulfillment_file);
    if (fromFF.length) return fromFF;

    // Fallback: để tránh 422
    const mock = item?.baseImage?.imageUrl || item?.mockup_url || "";
    if (mock) return [{ key: "front", url: String(mock) }];
    return [];
}

function buildInserts(orderObj = {}) {
    const inserts = [];
    const packing = orderObj.packing_slip_url || orderObj.packingSlipUrl || "";
    if (packing) {
        inserts.push({ name: "packing_slip", size: "8.5x11", url: String(packing) });
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
        preview_files: buildPreviewFiles(item),
        print_files: buildPrintFiles(item),
        inserts: buildInserts(orderObj),
    };
}

function buildPayload(orderObj = {}) {
    const customer = orderObj.customer_infor || {};
    const items = Array.isArray(orderObj.items) ? orderObj.items : [];
    const { firstName, lastName } = splitName(customer.name || "");
    const payload = {
        order_id: orderObj.orderId|| orderObj.order_id || "",
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
            orderObj.label_url || orderObj.labelUrl || orderObj.shipping_label_url || "",
        note: orderObj.note || orderObj.order_note || "",
        items: items.map((it) => buildMangoItem(it, orderObj)),
    };

    const preferredCarrier = resolvePreferredCarrier(orderObj, payload);
    if (preferredCarrier) {
        payload.preferred_carrier = preferredCarrier;
    }

    return payload;
}

/* -------------------- Preflight validation (avoid 422) ------------------- */
function validatePayload(p) {
    const errors = [];
    const need = (field, val) => {
        if (val === undefined || val === null || String(val).trim() === "") {
            errors.push(`Missing "${field}"`);
        }
    };

    need("order_id", p.order_id);
    need("first_name", p.first_name);
    need("last_name", p.last_name);
    need("email", p.email);
    need("address_line_1", p.address_line_1);
    need("city", p.city);
    need("state", p.state);
    need("zip", p.zip);
    need("country", p.country);

    if (
        p.shipping_method === "standard" &&
        isUSCountry(p.country) &&
        !String(p.label_url || "").trim()
    ) {
        need("preferred_carrier", p.preferred_carrier);
        if (p.preferred_carrier && !["auto", "usps"].includes(String(p.preferred_carrier).toLowerCase())) {
            errors.push('preferred_carrier must be "auto" or "usps"');
        }
    }

    if (!Array.isArray(p.items) || p.items.length === 0) {
        errors.push("Missing items[]");
    } else {
        p.items.forEach((it, idx) => {
            if (!it) {
                errors.push(`items[${idx}] is null/undefined`);
                return;
            }
            need(`items[${idx}].sku`, it.sku);
            if (!(Number(it.quantity) > 0)) {
                errors.push(`items[${idx}].quantity must be > 0`);
            }
            const hasPrint = Array.isArray(it.print_files) && it.print_files.length > 0;
            if (!hasPrint) {
                errors.push(`items[${idx}].print_files is required (min 1)`);
            } else {
                it.print_files.forEach((pf, j) => {
                    need(`items[${idx}].print_files[${j}].key`, pf?.key);
                    need(`items[${idx}].print_files[${j}].url`, pf?.url);
                    if (pf?.key && !ALLOWED_PRINT_KEYS.has(pf.key)) {
                        errors.push(`items[${idx}].print_files[${j}].key "${pf.key}" is not allowed`);
                    }
                });
            }
        });
    }
    return { ok: errors.length === 0, errors };
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

    if (!Number.isNaN(statusNum)) {
        if (statusNum >= 200 && statusNum < 300) {
            return {
                ok: true,
                externalId: pickExternalId(body),
                normalized: { status: statusNum, message: msg || "OK", data: bucket },
            };
        }
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
                normalized: { status: statusNum, message: msg || "OK (soft-success)", data: bucket, soft: true },
            };
        }
        const err = new Error(msg || "MangoTee: Error");
        err.code = "MANGOTEE_NON_SUCCESS";
        err.vendorResponse = body;
        return { ok: false, error: err };
    }

    if (msgLower.includes("created successfully") || msgLower.includes("order created") || msgLower.includes("success")) {
        return { ok: true, externalId: pickExternalId(body), normalized: { message: msg || "OK", data: bucket, soft: true } };
    }

    if (body && (body.id || body.order_id)) {
        return { ok: true, externalId: body.order_id || body.id || null, normalized: { data: body } };
    }

    const err = new Error("MangoTee: Unknown/invalid response");
    err.code = "MANGOTEE_INVALID_RESPONSE";
    err.vendorResponse = body;
    return { ok: false, error: err };
}

/* -------------------------- Sender ------------------------- */
async function send(orderDoc) {
    const orderObj = orderDoc?.toObject
        ? orderDoc.toObject({ getters: false, virtuals: false }) // Map có thể vẫn là Map nếu không flattenMaps
        : orderDoc;

    const payload = buildPayload(orderObj);

    // Preflight tránh 422
    const pre = validatePayload(payload);
    if (!pre.ok) {
        const err = new Error(`MangoTee payload validation failed: ${pre.errors.join("; ")}`);
        err.code = "MANGOTEE_PREVALIDATION_FAILED";
        err.details = pre.errors;
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
        const data = e?.response?.data;
        const status = e?.response?.status;
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
                return { data, externalId: parsedSoft.externalId, normalized: parsedSoft.normalized };
            }
        }

        if (status === 422 && data) {
            const reason = Array.isArray(data.errors)
                ? data.errors.map((x) => x?.message || x).join("; ")
                : data.message || "Unprocessable Entity";
            const err = new Error(`MangoTee 422: ${reason}`);
            err.code = "MANGOTEE_422";
            err.vendorResponse = data;
            throw err;
        }

        throw e;
    }

    if (!body || typeof body !== "object") {
        const err = new Error("MangoTee: Empty or invalid JSON response");
        err.code = "MANGOTEE_INVALID_RESPONSE";
        throw err;
    }

    const parsed = parseResponseForMangoTee(body);
    if (!parsed.ok) throw parsed.error;

    return { data: body, externalId: parsed.externalId, normalized: parsed.normalized };
}

module.exports = {
    key: "mangotee",
    canHandle: (orderDoc) => String(orderDoc.vendor || "").toLowerCase() === "mangotee",
    send,
};
