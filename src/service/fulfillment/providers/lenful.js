// services/fulfillment/providers/lenful.js
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
    // remove ext / extension part to avoid vendor validation issues
    const noExt = s.replace(/\b(ext|extension)\b\.?\s*\d+/gi, "").trim();
    const cleaned = noExt.replace(/[^\d+\-]/g, "");
    if (!/^\+/.test(cleaned) && /^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
    return cleaned;
}

function safeStr(v) {
    return v === undefined || v === null ? "" : String(v);
}

function isUrl(s) {
    const v = String(s || "").trim();
    return /^https?:\/\/\S+/i.test(v);
}

function dedupeByPosLink(arr) {
    const seen = new Set();
    return arr.filter((it) => {
        const k = `${it.position}|${it.link}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/* -------------------- Lenful position specs (per your latest message) -------------------- */
/**
 * Print position:
 * 0 Full
 * 1 Front
 * 2 Back
 * 3 LeftChest
 * 4 RightChest
 * 5 LeftSleeve
 * 6 RightSleeve
 * 7 Neck
 * 8 Full 3D
 */
const LENFUL_PRINT_POS = {
    full: 0,
    front: 1,
    back: 2,
    left_chest: 3,
    right_chest: 4,
    left_sleeve: 5,
    right_sleeve: 6,
    neck: 7,
    full_3d: 8,

    // aliases commonly used in systems
    leftChest: 3,
    rightChest: 4,
    rightSleeve: 6,
    leftSleeve: 5,
    neck_label: 7,
    center_chest: 1,
};

/**
 * Embroidery position:
 * 1 Front
 * 2 Back
 * 7 Neck
 * 6 Right Sleeve
 * 5 Left Sleeve
 * 31 Right
 * 32 Left
 * 39 Center Front
 * 40 Left Front
 * 41 Right Front
 * 42 Center Back
 */
const LENFUL_EMB_POS = {
    front: 1,
    back: 2,
    neck: 7,
    right_sleeve: 6,
    left_sleeve: 5,
    right: 31,
    left: 32,
    center_front: 39,
    left_front: 40,
    right_front: 41,
    center_back: 42,

    // aliases
    rightSleeve: 6,
    leftSleeve: 5,
    neck_label: 7,
};

/**
 * IMPORTANT:
 * Your EBMA (embroidered) variants' design_config requires:
 * Center Front, Left Front, Right Front, Left Sleeve, Right Sleeve, Neck, Center Back
 *
 * But your fulfillment_file uses keys like "front", "right_sleeve".
 * For embroidered goods, "front" MUST be mapped to Center Front (39) to match design_config.
 */
const EMB_FF_KEY_OVERRIDES = {
    front: 39, // Center Front
    back: 42, // Center Back
    right_sleeve: 6,
    left_sleeve: 5,
    neck: 7,
};

/* -------------------- Detect embroidery items (match your schema) -------------------- */
function isEmbroideryItem(item = {}) {
    const cb = item.cost_breakdown || {};
    const embCost = Number(cb?.additional_costs_breakdown?.embroidery || 0);
    const name = String(cb?.itemDisplayName || "").toLowerCase();
    const code = String(cb?.configCode || "").toUpperCase();
    return embCost > 0 || name.includes("embroider") || code === "EBMA";
}

/* -------------------- Collectors -------------------- */
function collectFromFulfillmentFile(ff, mapObj) {
    const out = [];
    if (!ff) return out;

    // Array: [{key,url}] or [{position,link}]
    if (Array.isArray(ff)) {
        ff.forEach((it) => {
            if (typeof it?.position === "number" && isUrl(it?.link)) {
                out.push({ position: it.position, link: String(it.link) });
                return;
            }
            const key = it?.key;
            const url = it?.url;
            const pos = mapObj[key] ?? mapObj[String(key || "").trim()];
            if (typeof pos === "number" && isUrl(url)) out.push({ position: pos, link: String(url) });
        });
        return dedupeByPosLink(out);
    }

    // Map
    if (ff instanceof Map) {
        ff.forEach((v, k) => {
            const pos = mapObj[k] ?? mapObj[String(k || "").trim()];
            if (typeof pos === "number" && isUrl(v)) out.push({ position: pos, link: String(v) });
        });
        return dedupeByPosLink(out);
    }

    // Object
    if (typeof ff === "object") {
        Object.keys(ff).forEach((k) => {
            const v = ff[k];
            const pos = mapObj[k] ?? mapObj[String(k || "").trim()];
            if (typeof pos === "number" && isUrl(v)) out.push({ position: pos, link: String(v) });
        });
        return dedupeByPosLink(out);
    }

    return out;
}

/* -------------------- Builders: designs / embroidereds / mockups -------------------- */
function buildDesigns(item = {}) {
    // If upstream already provided correct schema, use it
    if (Array.isArray(item.designs) && item.designs.length) {
        const provided = item.designs
            .filter((d) => typeof d?.position === "number" && isUrl(d?.link))
            .map((d) => ({
                position: d.position,
                link: String(d.link),
                link_blueprint: isUrl(d.link_blueprint) ? String(d.link_blueprint) : undefined,
            }));
        if (provided.length) return dedupeByPosLink(provided);
    }

    const emb = isEmbroideryItem(item);

    // Embroidery goods: map fulfillment_file by design_config overrides
    if (emb) {
        const fromFF = collectFromFulfillmentFile(item.fulfillment_file, EMB_FF_KEY_OVERRIDES);
        if (fromFF.length) return fromFF;

        // Fallback: use base image as Center Front (39)
        const base = item?.baseImage?.imageUrl || item?.snapshotImage || "";
        if (isUrl(base)) return [{ position: 39, link: String(base) }];
        return [];
    }

    // Normal print: use print positions
    const fromFF = collectFromFulfillmentFile(item.fulfillment_file, LENFUL_PRINT_POS);
    if (fromFF.length) return fromFF;

    // Fallback: base image as Front (1)
    const base = item?.baseImage?.imageUrl || item?.snapshotImage || "";
    if (isUrl(base)) return [{ position: 1, link: String(base) }];
    return [];
}

function buildEmbroidereds(item = {}) {
    if (!isEmbroideryItem(item)) return [];

    // If upstream already provided correct schema, use it
    if (Array.isArray(item.embroidereds) && item.embroidereds.length) {
        const provided = item.embroidereds
            .filter((e) => typeof e?.position === "number" && isUrl(e?.link))
            .map((e) => ({ position: e.position, link: String(e.link) }));
        if (provided.length) return dedupeByPosLink(provided);
    }

    // Use same override map as designs for embroidered goods
    return collectFromFulfillmentFile(item.fulfillment_file, EMB_FF_KEY_OVERRIDES);
}

function buildMockups(item = {}) {
    // If upstream already provided mockups, preserve them but validate format
    if (Array.isArray(item.mockups) && item.mockups.length) {
        const out = [];
        item.mockups.forEach((x) => {
            if (typeof x === "string" && isUrl(x)) out.push(String(x));
            if (x && typeof x === "object" && typeof x.position === "number" && isUrl(x.link)) {
                out.push({ position: x.position, link: String(x.link) });
            }
        });
        if (out.length) return out;
    }

    const baseMock = item?.baseImage?.imageUrl || item?.snapshotImage || "";
    const emb = isEmbroideryItem(item);

    // Non-embroidery: array string is OK
    if (!emb) {
        return isUrl(baseMock) ? [String(baseMock)] : [];
    }

    // Embroidery: must have mockup object per embroidery position
    const embs = buildEmbroidereds(item);
    const positions = embs.map((e) => e.position);
    const posList = positions.length ? positions : [39]; // default Center Front

    if (!isUrl(baseMock)) {
        // return placeholders to fail preflight clearly
        return posList.map((p) => ({ position: p, link: "" }));
    }

    return posList.map((p) => ({ position: p, link: String(baseMock) }));
}

/* -------------------- Shipping mapping -------------------- */
/**
 * Lenful shipping codes:
 * 0 Standard Shipping
 * 1 Ground Shipping
 * 2 Express Shipping
 * 3 3 Days Shipping
 * 4 Special Shipping
 * 5 US Island
 * 6 WW Standard Shipping
 * 7 Shipping By Platform
 */
function buildShippings(orderObj = {}, item = {}) {
    const platformLabel = safeStr(orderObj.platform_label || orderObj.platformLabel || "");
    if (platformLabel.trim() !== "") return [7];

    const rawCodes = item.shippings || orderObj.shippings;
    if (Array.isArray(rawCodes) && rawCodes.length) {
        return rawCodes.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    }

    const s = String(orderObj.shipping_type || orderObj.shippingType || orderObj.shipping_method || "")
        .toLowerCase()
        .trim();

    if (/^(express|expedited|priority|2d|two)/.test(s)) return [2, 1, 0];
    if (/^(ground)/.test(s)) return [1, 0, 2];
    if (/^(3\s*day|three)/.test(s)) return [3, 2, 1, 0];
    if (/^(standard|economy)/.test(s)) return [0, 1, 2];

    return [0, 1, 2];
}

/* -------------------- Item builder (match your order schema) -------------------- */
function buildLenfulItem(item = {}, orderObj = {}) {
    // design_sku: your internal SKU (item.sku)
    const designSku = safeStr(item.design_sku || item.designSku || item.sku || "");

    // product_sku: Lenful variant sku
    const productSku = safeStr(
        item.product_sku ||
        item.productSku ||
        item.cost_breakdown?.matchedSku ||
        item.mapped_sku ||
        item.sku ||
        ""
    );

    const designs = buildDesigns(item);
    const mockups = buildMockups(item);
    const embroidereds = buildEmbroidereds(item);

    const requestClone =
        typeof item.request_clone === "boolean"
            ? item.request_clone
            : typeof item.requestClone === "boolean"
                ? item.requestClone
                : false;

    const payloadItem = {
        design_sku: designSku,
        product_sku: productSku,
        quantity: Number(item.quantity || 1),
        mockups,
        designs: designs.map((d) => ({
            position: d.position,
            link: d.link,
            ...(d.link_blueprint ? { link_blueprint: d.link_blueprint } : {}),
        })),
        request_clone: requestClone,
        shippings: buildShippings(orderObj, item),
    };

    if (embroidereds.length) {
        payloadItem.embroidereds = embroidereds.map((e) => ({
            position: e.position,
            link: e.link,
        }));
    }

    return payloadItem;
}

/* -------------------- Payload builder -------------------- */
function buildPayload(orderObj = {}) {
    const customer = orderObj.customer_infor || {};
    const items = Array.isArray(orderObj.items) ? orderObj.items : [];
    const { firstName, lastName } = splitName(customer.name || "");

    return {
        order_number: safeStr(orderObj.order_number || orderObj.orderNumber || orderObj.orderId || orderObj.order_id || ""),
        first_name: safeStr(customer.first_name || customer.firstName || firstName),
        last_name: safeStr(customer.last_name || customer.lastName || lastName),
        email: safeStr(customer.email || ""),
        phone: normalizePhone(customer.phone_number || customer.phone || ""),
        country_code: safeStr(customer.country_code || customer.countryCode || customer.country || "US").toUpperCase(),
        province: safeStr(customer.province || customer.state || ""),
        city: safeStr(customer.city || ""),
        zip: safeStr(customer.zip_code || customer.zip || ""),
        address_1: safeStr(customer.address || customer.address_1 || ""),
        address_2: safeStr(customer.address_2 || ""),
        note: safeStr(orderObj.note || orderObj.order_note || ""),
        platform_label: safeStr(orderObj.platform_label || orderObj.platformLabel || ""),
        items: items.map((it) => buildLenfulItem(it, orderObj)),
    };
}

/* -------------------- Preflight validation (avoid vendor 4xx) -------------------- */
function validatePayload(p) {
    const errors = [];
    const need = (field, val) => {
        if (val === undefined || val === null || String(val).trim() === "") errors.push(`Missing "${field}"`);
    };

    need("order_number", p.order_number);
    need("first_name", p.first_name);
    need("last_name", p.last_name);
    need("email", p.email);
    need("country_code", p.country_code);
    need("province", p.province);
    need("city", p.city);
    need("zip", p.zip);
    need("address_1", p.address_1);

    if (!Array.isArray(p.items) || p.items.length === 0) {
        errors.push("Missing items[]");
    } else {
        p.items.forEach((it, idx) => {
            need(`items[${idx}].design_sku`, it.design_sku);
            need(`items[${idx}].product_sku`, it.product_sku);

            if (!(Number(it.quantity) > 0)) errors.push(`items[${idx}].quantity must be > 0`);

            // designs required
            if (!Array.isArray(it.designs) || it.designs.length === 0) {
                errors.push(`items[${idx}].designs is required (min 1)`);
            } else {
                it.designs.forEach((d, j) => {
                    if (typeof d?.position !== "number") errors.push(`items[${idx}].designs[${j}].position must be number`);
                    need(`items[${idx}].designs[${j}].link`, d?.link);
                    if (d?.link && !isUrl(d.link)) errors.push(`items[${idx}].designs[${j}].link is not a valid URL`);
                });
            }

            // shipping rule: if platform_label present, shippings must include 7
            if (String(p.platform_label || "").trim() !== "") {
                if (!Array.isArray(it.shippings) || !it.shippings.includes(7)) {
                    errors.push(`items[${idx}].shippings must include 7 when platform_label is present`);
                }
            }

            // embroidery rule: if embroidereds exists -> mockups must be objects with matching positions
            if (Array.isArray(it.embroidereds) && it.embroidereds.length) {
                if (!Array.isArray(it.mockups) || it.mockups.length === 0) {
                    errors.push(`items[${idx}].mockups is required for embroidered goods`);
                } else {
                    // mockups must be object with position
                    const mockObj = it.mockups.filter((m) => m && typeof m === "object");
                    if (mockObj.length !== it.mockups.length) {
                        errors.push(`items[${idx}].mockups must be array of {position,link} for embroidered goods`);
                    } else {
                        const mockPos = new Set(mockObj.map((m) => m.position));
                        it.embroidereds.forEach((e, j) => {
                            if (typeof e?.position !== "number") errors.push(`items[${idx}].embroidereds[${j}].position must be number`);
                            need(`items[${idx}].embroidereds[${j}].link`, e?.link);
                            if (e?.link && !isUrl(e.link)) errors.push(`items[${idx}].embroidereds[${j}].link is not a valid URL`);
                            if (typeof e?.position === "number" && !mockPos.has(e.position)) {
                                errors.push(`items[${idx}] missing mockup for embroidery position ${e.position}`);
                            }
                        });

                        mockObj.forEach((m, j) => {
                            need(`items[${idx}].mockups[${j}].link`, m?.link);
                            if (m?.link && !isUrl(m.link)) errors.push(`items[${idx}].mockups[${j}].link is not a valid URL`);
                            if (typeof m?.position !== "number") errors.push(`items[${idx}].mockups[${j}].position must be number`);
                        });
                    }
                }
            }
        });
    }

    return { ok: errors.length === 0, errors };
}

/* -------------------- Response parser (generic) -------------------- */
function parseResponseForLenful(body) {
    const msg = String(body?.message || body?.msg || "").trim();
    const statusNum = Number(body?.status || body?.code);

    const pickExternalId = (b = {}) => {
        const d = b.data || b.result || {};
        return d.order_number || d.orderNo || d.id || b.order_number || b.orderNo || b.id || null;
    };

    if (typeof body?.success === "boolean") {
        if (body.success) {
            return {
                ok: true,
                externalId: pickExternalId(body),
                normalized: { success: true, message: msg || "OK", data: body.data || body },
            };
        }
        const err = new Error(msg || "Lenful: Non-success response");
        err.code = "LENFUL_NON_SUCCESS";
        err.vendorResponse = body;
        return { ok: false, error: err };
    }

    if (!Number.isNaN(statusNum)) {
        if (statusNum >= 200 && statusNum < 300) {
            return {
                ok: true,
                externalId: pickExternalId(body),
                normalized: { status: statusNum, message: msg || "OK", data: body.data || body },
            };
        }
        const err = new Error(msg || "Lenful: Error");
        err.code = "LENFUL_NON_SUCCESS";
        err.vendorResponse = body;
        return { ok: false, error: err };
    }

    if (body && (body.id || body.order_number || body.orderNo)) {
        return {
            ok: true,
            externalId: body.order_number || body.orderNo || body.id || null,
            normalized: { message: msg || "OK (soft)", data: body, soft: true },
        };
    }

    const err = new Error("Lenful: Unknown/invalid response");
    err.code = "LENFUL_INVALID_RESPONSE";
    err.vendorResponse = body;
    return { ok: false, error: err };
}

/* -------------------------- Sender ------------------------- */
async function send(orderDoc) {
    const orderObj = orderDoc?.toObject
        ? orderDoc.toObject({ getters: false, virtuals: false })
        : orderDoc;

    const payload = buildPayload(orderObj);

    // Preflight to fail fast (avoid vendor errors)
    const pre = validatePayload(payload);
    if (!pre.ok) {
        const err = new Error(`Lenful payload validation failed: ${pre.errors.join("; ")}`);
        err.code = "LENFUL_PREVALIDATION_FAILED";
        err.details = pre.errors;
        throw err;
    }

    const endpoint =
        process.env.LENFUL_ENDPOINT ||
        "https://s-lencam.lenful.com/api/order/69649e9f9a20f6378af90995/create?isCheckOrderNumber=false"; // TODO: replace with real endpoint

    const apiKey =
        process.env.LENFUL_API_KEY ||
        process.env.LENFUL_ACCESS_TOKEN ||
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjY5NjQ5ZTlmYTMzY2MzYzkyNzU4ZGQxMyIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL2VtYWlsYWRkcmVzcyI6Im5ndXllbnRoYW5obG9uZzAxMDk1NUBnbWFpbC5jb20iLCJGaXJ0TmFtZSI6IkxPTkciLCJTaG9ydElkIjoiRTgxNjc1MDciLCJMYXN0TmFtZSI6Ik5HVVnhu4ROIFRIw4BOSCIsIkZ1bGxOYW1lIjoiTE9ORyBOR1VZ4buETiBUSMOATkgiLCJVc2VyTmFtZSI6IiIsIlRva2VuVHlwZSI6IkN1c3RvbWVyIiwiU2hvcHMiOiJbXCI2MzMxNzRlYWExNDNmODE2ZDUxOGI3ZjFcIl0iLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJvd25lcnMiLCJNYW5hZ2VycyI6Ilt7XCJtYW5hZ2VyX2lkXCI6XCI2NTI3YjBmNmUzMjMzMTk3ZTU0MzhkZDNcIixcIm1hbmFnZXJfbmFtZVwiOlwiW0RFVl0gU3VwcG9ydCBMZW5mdWxcIn0se1wibWFuYWdlcl9pZFwiOlwiNjcwM2I4ZTdmYTQxZjVmNjk0M2RmNTcwXCIsXCJtYW5hZ2VyX25hbWVcIjpcIltTUFRdIFRodSBIw6BcIn0se1wibWFuYWdlcl9pZFwiOlwiNjgyMzAyMDg2MTIwZjIzNWYxM2IyOTQxXCIsXCJtYW5hZ2VyX25hbWVcIjpcIltTQUxdIFRow7p5IMSQ4buXXCJ9XSIsIm5iZiI6MTc2ODYxODc2NiwiZXhwIjoxNzcxMjEwNzY2LCJ3YWxsZXRfaWQiOiI2OTY0OWU5ZmRmNjhmYWZmMWUxMjE4NTUifQ.8JHD6UrrLTg1Ru3-PAt14Kqk1UBc6v5WYgKFrgjW3IQ";

    if (!apiKey) {
        const err = new Error("Missing LENFUL_API_KEY in environment");
        err.code = "LENFUL_MISSING_API_KEY";
        throw err;
    }

    // If Lenful uses X-API-Key instead, replace Authorization below.
    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
    };

    console.log("[LENFUL] Create order endpoint:", endpoint);
    console.log("[LENFUL] Sending payload:", JSON.stringify(payload, null, 2));

    let body;
    try {
        const resp = await axios.post(endpoint, payload, { headers });
        body = resp?.data;
    } catch (e) {
        const data = e?.response?.data;
        const status = e?.response?.status;

        if (status === 422 && data) {
            const reason = Array.isArray(data.errors)
                ? data.errors.map((x) => x?.message || x).join("; ")
                : data.message || "Unprocessable Entity";
            const err = new Error(`Lenful 422: ${reason}`);
            err.code = "LENFUL_422";
            err.vendorResponse = data;
            throw err;
        }

        // Soft-success heuristics
        if (data && typeof data === "object") {
            const msg = String(data?.message || "").toLowerCase();
            const looksLikeSuccess =
                msg.includes("created") ||
                msg.includes("success") ||
                msg.includes("already exist") ||
                msg.includes("already created");

            if (looksLikeSuccess) {
                const parsedSoft = parseResponseForLenful(data);
                if (parsedSoft.ok) {
                    return { data, externalId: parsedSoft.externalId, normalized: parsedSoft.normalized };
                }
            }
        }

        throw e;
    }

    if (!body || typeof body !== "object") {
        const err = new Error("Lenful: Empty or invalid JSON response");
        err.code = "LENFUL_INVALID_RESPONSE";
        throw err;
    }

    const parsed = parseResponseForLenful(body);
    if (!parsed.ok) throw parsed.error;

    return { data: body, externalId: parsed.externalId, normalized: parsed.normalized };
}

module.exports = {
    key: "lenful",
    canHandle: (orderDoc) => String(orderDoc.vendor || "").toLowerCase() === "lenful",
    send,
};
