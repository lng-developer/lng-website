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

function dedupeByPosLink(arr = []) {
    const seen = new Set();
    return arr.filter((it) => {
        const k = `${it.position}|${it.link}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/* -------------------- Position specs -------------------- */
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

    // aliases
    leftChest: 3,
    rightChest: 4,
    leftSleeve: 5,
    rightSleeve: 6,
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
    leftSleeve: 5,
    rightSleeve: 6,
    neck_label: 7,
};

const EMB_ALLOWED_POSITIONS = new Set([1, 2, 5, 6, 7, 31, 32, 39, 40, 41, 42]);
const EMBROIDERY_CONFIG_CODES = new Set(["EBM", "EBMA"]);

/**
 * Với case thực tế của bạn:
 * front artwork phải map sang Center Front (39), không phải Front (1)
 */
const EMB_FF_KEY_OVERRIDES = {
    front: 39,
    back: 42,
    left_sleeve: 5,
    right_sleeve: 6,
    neck: 7,
};

function remapProvidedEmbPosition(position) {
    const p = Number(position);
    const map = {
        // print-like positions -> embroidery positions theo config thực tế
        1: 39, // Front -> Center Front
        2: 42, // Back -> Center Back
        3: 40, // LeftChest -> Left Front
        4: 41, // RightChest -> Right Front
        5: 5,
        6: 6,
        7: 7,

        // already embroidery
        31: 31,
        32: 32,
        39: 39,
        40: 40,
        41: 41,
        42: 42,
    };
    return map[p];
}

/* -------------------- Detect embroidery -------------------- */
function isEmbroideryItem(item = {}) {
    if (item.is_embroidery === true) return true;

    const cb = item.cost_breakdown || {};
    const embCost = Number(cb?.additional_costs_breakdown?.embroidery || 0);
    const name = String(
        cb?.itemDisplayName ||
        item?.itemDisplayName ||
        item?.product_name ||
        item?.title ||
        ""
    ).toLowerCase();
    const code = String(
        cb?.configCode ||
        item?.configCode ||
        item?.config_code ||
        ""
    ).toUpperCase();

    if (embCost > 0 || name.includes("embroider") || EMBROIDERY_CONFIG_CODES.has(code)) return true;

    // fallback theo field upstream
    if (Array.isArray(item.embroidereds) && item.embroidereds.length > 0) return true;

    // fallback cứng cho known SKU đang dùng
    const productSku = String(
        item.product_sku ||
        item.productSku ||
        cb?.matchedSku ||
        item.mapped_sku ||
        item.sku ||
        ""
    ).toUpperCase();
    const designSku = String(item.design_sku || item.orderItemId || "").trim();

    if (productSku === "LFVNA1632ANAL") return true;
    if (designSku === "157220035307881") return true;

    return false;
}

/* -------------------- Collectors -------------------- */
function collectFromFulfillmentFile(ff, mapObj) {
    const out = [];
    if (!ff) return out;

    if (Array.isArray(ff)) {
        ff.forEach((it) => {
            if (typeof it?.position === "number" && isUrl(it?.link)) {
                out.push({ position: Number(it.position), link: String(it.link) });
                return;
            }
            const key = String(it?.key || "").trim();
            const url = it?.url;
            const pos = mapObj[key];
            if (typeof pos === "number" && isUrl(url)) {
                out.push({ position: pos, link: String(url) });
            }
        });
        return dedupeByPosLink(out);
    }

    if (ff instanceof Map) {
        ff.forEach((v, k) => {
            const pos = mapObj[String(k || "").trim()];
            if (typeof pos === "number" && isUrl(v)) {
                out.push({ position: pos, link: String(v) });
            }
        });
        return dedupeByPosLink(out);
    }

    if (typeof ff === "object") {
        Object.keys(ff).forEach((k) => {
            const pos = mapObj[String(k || "").trim()];
            const v = ff[k];
            if (typeof pos === "number" && isUrl(v)) {
                out.push({ position: pos, link: String(v) });
            }
        });
        return dedupeByPosLink(out);
    }

    return out;
}

/* -------------------- Builders -------------------- */
function buildDesigns(item = {}) {
    if (isEmbroideryItem(item)) {
        // Case embroidery thực tế đang chạy tốt với chỉ embroidereds, không cần designs
        return [];
    }

    if (Array.isArray(item.designs) && item.designs.length) {
        const provided = item.designs
            .filter((d) => typeof d?.position === "number" && isUrl(d?.link))
            .map((d) => ({
                position: Number(d.position),
                link: String(d.link),
                ...(isUrl(d.link_blueprint) ? { link_blueprint: String(d.link_blueprint) } : {}),
            }));

        if (provided.length) return dedupeByPosLink(provided);
    }

    const fromFF = collectFromFulfillmentFile(item.fulfillment_file, LENFUL_PRINT_POS);
    if (fromFF.length) return fromFF;

    const base = item?.baseImage?.imageUrl || item?.snapshotImage || "";
    if (isUrl(base)) return [{ position: 1, link: String(base) }];

    return [];
}

function buildEmbroidereds(item = {}) {
    if (!isEmbroideryItem(item)) return [];

    if (Array.isArray(item.embroidereds) && item.embroidereds.length) {
        const provided = item.embroidereds
            .filter((e) => typeof e?.position === "number" && isUrl(e?.link))
            .map((e) => ({
                position: remapProvidedEmbPosition(e.position),
                link: String(e.link),
            }))
            .filter((e) => typeof e.position === "number");

        if (provided.length) return dedupeByPosLink(provided);
    }

    if (Array.isArray(item.designs) && item.designs.length) {
        const mappedFromDesigns = item.designs
            .filter((d) => typeof d?.position === "number" && isUrl(d?.link))
            .map((d) => ({
                position: remapProvidedEmbPosition(d.position),
                link: String(d.link),
            }))
            .filter((e) => typeof e.position === "number");

        if (mappedFromDesigns.length) return dedupeByPosLink(mappedFromDesigns);
    }

    const fromFF = collectFromFulfillmentFile(item.fulfillment_file, EMB_FF_KEY_OVERRIDES);
    if (fromFF.length) return fromFF;

    const base = item?.baseImage?.imageUrl || item?.snapshotImage || "";
    if (isUrl(base)) return [{ position: 39, link: String(base) }];

    return [];
}

function buildMockups(item = {}) {
    const emb = isEmbroideryItem(item);

    if (!emb) {
        if (Array.isArray(item.mockups) && item.mockups.length) {
            const out = [];
            item.mockups.forEach((x) => {
                if (typeof x === "string" && isUrl(x)) out.push(String(x));
            });
            if (out.length) return out;
        }

        const baseMock = item?.baseImage?.imageUrl || item?.snapshotImage || "";
        return isUrl(baseMock) ? [String(baseMock)] : [];
    }

    // Embroidery: mockups phải là object array có position theo behavior thực tế
    const embDesigns = buildEmbroidereds(item);
    const positions = embDesigns.map((e) => e.position);

    if (Array.isArray(item.mockups) && item.mockups.length) {
        const objectMocks = item.mockups
            .filter((x) => x && typeof x === "object" && typeof x.position === "number" && isUrl(x.link))
            .map((x) => ({
                position: remapProvidedEmbPosition(x.position),
                link: String(x.link),
            }))
            .filter((m) => typeof m.position === "number");

        if (objectMocks.length) {
            return dedupeByPosLink(objectMocks);
        }

        const firstStringMock = item.mockups.find((x) => typeof x === "string" && isUrl(x));
        if (isUrl(firstStringMock)) {
            return positions.map((p) => ({
                position: p,
                link: String(firstStringMock),
            }));
        }
    }

    const baseMock = item?.baseImage?.imageUrl || item?.snapshotImage || "";
    if (isUrl(baseMock) && positions.length) {
        return positions.map((p) => ({
            position: p,
            link: String(baseMock),
        }));
    }

    return [];
}

/* -------------------- Shipping mapping -------------------- */
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
    if (/^(standard|freeeconomy)/.test(s)) return [0, 1, 2];

    return [0, 1, 2];
}

/* -------------------- Item builder -------------------- */
function buildLenfulItem(item = {}, orderObj = {}) {
    const designSku = safeStr(item.design_sku || item.orderItemId || "");
    const productSku = safeStr(
        item.product_sku ||
        item.productSku ||
        item.cost_breakdown?.matchedSku ||
        item.mapped_sku ||
        item.sku ||
        ""
    );

    const emb = isEmbroideryItem(item);
    const designs = buildDesigns(item);
    const embroidereds = buildEmbroidereds(item);
    const mockups = buildMockups(item);

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
        request_clone: requestClone,
        shippings: buildShippings(orderObj, item),
    };

    if (emb) {
        payloadItem.embroidereds = embroidereds;
    } else {
        payloadItem.designs = designs;
    }

    return payloadItem;
}

/* -------------------- Payload builder -------------------- */
function buildPayload(orderObj = {}) {
    const customer = orderObj.customer_infor || orderObj.customer || {};
    const items = Array.isArray(orderObj.items) ? orderObj.items : [];
    const { firstName, lastName } = splitName(customer.name || "");

    return {
        order_number: safeStr(orderObj.order_number || orderObj.orderNumber || orderObj.orderId || orderObj.order_id || ""),
        first_name: safeStr(customer.first_name || customer.firstName || firstName),
        last_name: safeStr(customer.last_name || customer.lastName || lastName),
        email: safeStr(customer.email || orderObj.email || ""),
        phone: normalizePhone(customer.phone_number || customer.phone || orderObj.phone || ""),
        country_code: safeStr(customer.country_code || customer.countryCode || customer.country || orderObj.country_code || "US").toUpperCase(),
        province: safeStr(customer.province || customer.state || orderObj.province || ""),
        city: safeStr(customer.city || orderObj.city || ""),
        zip: safeStr(customer.zip_code || customer.zip || orderObj.zip || ""),
        address_1: safeStr(customer.address || customer.address_1 || orderObj.address_1 || ""),
        address_2: safeStr(customer.address_2 || orderObj.address_2 || ""),
        note: safeStr(orderObj.note || orderObj.order_note || ""),
        platform_label: safeStr(orderObj.platform_label || orderObj.platformLabel || ""),
        items: items.map((it) => buildLenfulItem(it, orderObj)),
    };
}

/* -------------------- Validation -------------------- */
function validatePayload(p) {
    const errors = [];
    const need = (field, val) => {
        if (val === undefined || val === null || String(val).trim() === "") {
            errors.push(`Missing "${field}"`);
        }
    };

    need("order_number", p.order_number);

    if (!Array.isArray(p.items) || p.items.length === 0) {
        errors.push("Missing items[]");
        return { ok: false, errors };
    }

    p.items.forEach((it, idx) => {
        need(`items[${idx}].design_sku`, it.design_sku);
        need(`items[${idx}].product_sku`, it.product_sku);

        if (!(Number(it.quantity) > 0)) {
            errors.push(`items[${idx}].quantity must be > 0`);
        }

        if (String(p.platform_label || "").trim() !== "") {
            if (!Array.isArray(it.shippings) || !it.shippings.includes(7)) {
                errors.push(`items[${idx}].shippings must include 7 when platform_label is present`);
            }
        }

        const hasEmb = Array.isArray(it.embroidereds) && it.embroidereds.length > 0;
        const hasDesigns = Array.isArray(it.designs) && it.designs.length > 0;

        if (!hasEmb && !hasDesigns) {
            errors.push(`items[${idx}] must have either designs or embroidereds`);
        }

        if (hasEmb) {
            it.embroidereds.forEach((e, j) => {
                if (typeof e?.position !== "number") {
                    errors.push(`items[${idx}].embroidereds[${j}].position must be number`);
                }
                if (!EMB_ALLOWED_POSITIONS.has(Number(e?.position))) {
                    errors.push(`items[${idx}].embroidereds[${j}].position is invalid`);
                }
                need(`items[${idx}].embroidereds[${j}].link`, e?.link);
                if (e?.link && !isUrl(e.link)) {
                    errors.push(`items[${idx}].embroidereds[${j}].link is not a valid URL`);
                }
            });

            if (!Array.isArray(it.mockups) || it.mockups.length === 0) {
                errors.push(`items[${idx}].mockups is required for embroidery item`);
            } else {
                it.mockups.forEach((m, j) => {
                    if (!(m && typeof m === "object")) {
                        errors.push(`items[${idx}].mockups[${j}] must be object {position, link} for embroidery item`);
                        return;
                    }

                    if (typeof m.position !== "number") {
                        errors.push(`items[${idx}].mockups[${j}].position must be number`);
                    }
                    if (!EMB_ALLOWED_POSITIONS.has(Number(m.position))) {
                        errors.push(`items[${idx}].mockups[${j}].position is invalid`);
                    }
                    need(`items[${idx}].mockups[${j}].link`, m.link);
                    if (m.link && !isUrl(m.link)) {
                        errors.push(`items[${idx}].mockups[${j}].link is not a valid URL`);
                    }
                });

                const embPos = new Set(it.embroidereds.map((e) => e.position));
                const mockPos = new Set(
                    it.mockups
                        .filter((m) => m && typeof m === "object" && typeof m.position === "number")
                        .map((m) => m.position)
                );

                embPos.forEach((pos) => {
                    if (!mockPos.has(pos)) {
                        errors.push(`items[${idx}] missing mockup for embroidery position ${pos}`);
                    }
                });
            }
        }

        if (hasDesigns) {
            it.designs.forEach((d, j) => {
                if (typeof d?.position !== "number") {
                    errors.push(`items[${idx}].designs[${j}].position must be number`);
                }
                need(`items[${idx}].designs[${j}].link`, d?.link);
                if (d?.link && !isUrl(d.link)) {
                    errors.push(`items[${idx}].designs[${j}].link is not a valid URL`);
                }
            });

            if (Array.isArray(it.mockups) && it.mockups.length > 0) {
                it.mockups.forEach((m, j) => {
                    if (typeof m !== "string" || !isUrl(m)) {
                        errors.push(`items[${idx}].mockups[${j}] must be URL string for non-embroidery item`);
                    }
                });
            }
        }
    });

    return { ok: errors.length === 0, errors };
}

/* -------------------- Response parser -------------------- */
function parseResponseForLenful(body) {
    const msg = String(body?.message || body?.msg || "").trim();
    const statusNum = Number(body?.status || body?.code);

    const pickExternalId = (b = {}) => {
        const d = b.data || b.result || {};
        return d.order_number || d.orderNo || d.id || b.order_number || b.orderNo || b.id || null;
    };

    const extractOrderNumberFromMessage = (m = "") => {
        const match = String(m || "").match(/order number\s*([0-9A-Za-z-]+)/i);
        return match?.[1] || null;
    };

    const externalId = pickExternalId(body) || extractOrderNumberFromMessage(msg);

    if (typeof body?.success === "boolean") {
        if (body.success) {
            return {
                ok: true,
                externalId,
                normalized: { success: true, message: msg || "OK", data: body.data || body },
            };
        }

        if (externalId) {
            return {
                ok: true,
                externalId,
                normalized: { success: true, message: msg || "OK (soft)", data: body.data || body, soft: true },
            };
        }

        const err = new Error(msg || "Lenful: Non-success response");
        err.code = "LENFUL_NON_SUCCESS";
        err.vendorResponse = body;
        return { ok: false, error: err };
    }

    if (!Number.isNaN(statusNum)) {
        // một số response của vendor dùng status=true/false, nên chỉ coi number 2xx là success
        if (statusNum >= 200 && statusNum < 300) {
            return {
                ok: true,
                externalId,
                normalized: { status: statusNum, message: msg || "OK", data: body.data || body },
            };
        }
    }

    if (body && (body.id || body.order_number || body.orderNo)) {
        return {
            ok: true,
            externalId: externalId || body.order_number || body.orderNo || body.id || null,
            normalized: { message: msg || "OK (soft)", data: body, soft: true },
        };
    }

    const err = new Error(msg || "Lenful: Unknown/invalid response");
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

    const pre = validatePayload(payload);
    if (!pre.ok) {
        const err = new Error(`Lenful payload validation failed: ${pre.errors.join("; ")}`);
        err.code = "LENFUL_PREVALIDATION_FAILED";
        err.details = pre.errors;
        err.payload = payload;
        throw err;
    }

    const endpoint =
        process.env.LENFUL_ENDPOINT ||
        "https://s-lencam.lenful.com/api/order/69649e9f9a20f6378af90995/create?isCheckOrderNumber=false";

    const apiKey =
        process.env.LENFUL_API_KEY ||
        process.env.LENFUL_ACCESS_TOKEN ||
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjY5NjQ5ZTlmYTMzY2MzYzkyNzU4ZGQxMyIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL2VtYWlsYWRkcmVzcyI6Im5ndXllbnRoYW5obG9uZzAxMDk1NUBnbWFpbC5jb20iLCJGaXJ0TmFtZSI6IkxPTkciLCJTaG9ydElkIjoiRTgxNjc1MDciLCJMYXN0TmFtZSI6Ik5HVVnhu4ROIFRIw4BOSCIsIkZ1bGxOYW1lIjoiTE9ORyBOR1VZ4buETiBUSMOATkgiLCJVc2VyTmFtZSI6IiIsIlRva2VuVHlwZSI6IkN1c3RvbWVyIiwiU2hvcHMiOiJbXCI2MzMxNzRlYWExNDNmODE2ZDUxOGI3ZjFcIl0iLCJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL3dzLzIwMDgvMDYvaWRlbnRpdHkvY2xhaW1zL3JvbGUiOiJvd25lcnMiLCJNYW5hZ2VycyI6Ilt7XCJtYW5hZ2VyX2lkXCI6XCI2ODIzMDIwODYxMjBmMjM1ZjEzYjI5NDFcIixcIm1hbmFnZXJfbmFtZVwiOlwiW1NBTF0gVGjDunkgxJDhu5dcIn0se1wibWFuYWdlcl9pZFwiOlwiNjYwMGUxYmU0MDYxYTFhNDg2OTRlNzM2XCIsXCJtYW5hZ2VyX25hbWVcIjpcIltTUFRdIEPDoXQgTmjDo1wifV0iLCJuYmYiOjE3NzY1MjA0NDYsImV4cCI6MTc3OTExMjQ0Niwid2FsbGV0X2lkIjoiNjk2NDllOWZkZjY4ZmFmZjFlMTIxODU1In0.SO7yUsKA-s2NMJw7_Te2YY9hI-9EEZG0RFhA3KCzGX8"
    if (!apiKey) {
        const err = new Error("Missing LENFUL_API_KEY in environment");
        err.code = "LENFUL_MISSING_API_KEY";
        throw err;
    }

    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
    };

    console.log("[LENFUL] Sending payload:", JSON.stringify(payload, null, 2));

    let body;
    try {
        const resp = await axios.post(endpoint, payload, { headers });
        body = resp?.data;
    } catch (e) {
        const status = e?.response?.status;
        const data = e?.response?.data;

        console.error("[LENFUL] Request failed - status:", status);
        console.error("[LENFUL] Vendor response:", JSON.stringify(data, null, 2));
        console.error("[LENFUL] Payload:", JSON.stringify(payload, null, 2));

        const err = new Error(
            `Lenful request failed: status=${status || "unknown"}, message=${data?.message || e.message}`
        );
        err.code = "LENFUL_REQUEST_FAILED";
        err.vendorResponse = data;
        err.payload = payload;
        throw err;
    }

    if (!body || typeof body !== "object") {
        const err = new Error("Lenful: Empty or invalid JSON response");
        err.code = "LENFUL_INVALID_RESPONSE";
        err.payload = payload;
        throw err;
    }

    const parsed = parseResponseForLenful(body);
    if (!parsed.ok) {
        parsed.error.payload = payload;
        throw parsed.error;
    }

    return {
        data: body,
        externalId: parsed.externalId,
        normalized: parsed.normalized,
    };
}

module.exports = {
    key: "lenful",
    canHandle: (orderDoc) => String(orderDoc.vendor || "").toLowerCase() === "lenful",
    send,
    _private: {
        buildPayload,
        buildLenfulItem,
        isEmbroideryItem,
        buildDesigns,
        buildEmbroidereds,
        buildMockups,
    },
};
