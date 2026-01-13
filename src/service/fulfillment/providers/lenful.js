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
  // giữ +, -, số; bỏ "ext."
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

/* -------------------- Lenful position mapping -------------------- */
/**
 * designs.position:
 * 0 Full, 1 Front, 2 Back, 3 LeftCheft, 4 RightCheft
 */
const LENFUL_DESIGN_POS = {
  full: 0,
  front: 1,
  back: 2,
  left_chest: 3,
  right_chest: 4,

  // aliases hệ thống hay dùng
  center_chest: 1,
  leftChest: 3,
  rightChest: 4,
};

function dedupeByPosLink(arr) {
  const seen = new Set();
  return arr.filter((it) => {
    const k = `${it.position}|${it.link}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Collect designs from fulfillment_file (Map/Object/Array) */
function collectDesignsFromFulfillmentFile(ff) {
  const out = [];
  if (!ff) return out;

  // Array: [{key,url}] hoặc [{position,link}]
  if (Array.isArray(ff)) {
    ff.forEach((it) => {
      if (typeof it?.position === "number" && isUrl(it?.link)) {
        out.push({ position: it.position, link: String(it.link) });
        return;
      }
      const key = it?.key;
      const url = it?.url;
      const pos = LENFUL_DESIGN_POS[key] ?? LENFUL_DESIGN_POS[String(key || "").trim()];
      if (typeof pos === "number" && isUrl(url)) out.push({ position: pos, link: String(url) });
    });
    return dedupeByPosLink(out);
  }

  // Map
  if (ff instanceof Map) {
    ff.forEach((v, k) => {
      const pos = LENFUL_DESIGN_POS[k] ?? LENFUL_DESIGN_POS[String(k || "").trim()];
      if (typeof pos === "number" && isUrl(v)) out.push({ position: pos, link: String(v) });
    });
    return dedupeByPosLink(out);
  }

  // Object
  if (typeof ff === "object") {
    Object.keys(ff).forEach((k) => {
      const v = ff[k];
      const pos = LENFUL_DESIGN_POS[k] ?? LENFUL_DESIGN_POS[String(k || "").trim()];
      if (typeof pos === "number" && isUrl(v)) out.push({ position: pos, link: String(v) });
    });
    return dedupeByPosLink(out);
  }

  return out;
}

function buildMockups(item = {}) {
  // Lenful mockups: array string OR array object {position,link}
  const out = [];

  // nếu hệ thống bạn có sẵn item.mockups thì ưu tiên
  if (Array.isArray(item.mockups) && item.mockups.length) {
    item.mockups.forEach((x) => {
      if (typeof x === "string" && isUrl(x)) out.push(String(x));
      if (x && typeof x === "object" && isUrl(x.link)) out.push({ position: x.position, link: String(x.link) });
    });
    return out;
  }

  // fallback theo order mẫu: baseImage.imageUrl hoặc snapshotImage
  const base = item?.baseImage?.imageUrl || "";
  const snap = item?.snapshotImage || "";

  if (isUrl(base)) out.push(String(base));
  else if (isUrl(snap)) out.push(String(snap));

  return out;
}

function buildDesigns(item = {}) {
  // 1) nếu item.designs đã đúng schema thì dùng
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

  // 2) lấy từ fulfillment_file (order mẫu có fulfillment_file.front)
  const fromFF = collectDesignsFromFulfillmentFile(item.fulfillment_file);
  if (fromFF.length) return fromFF;

  // 3) fallback: dùng baseImage như front để tránh lỗi thiếu design
  const base = item?.baseImage?.imageUrl || "";
  if (isUrl(base)) return [{ position: 1, link: String(base) }];

  return [];
}

/* -------------------- Shipping mapping -------------------- */
/**
 * Lenful item.shippings codes (priority left->right)
 * 0 Standard,1 Ground,2 Express,3 3 Days,4 Special,5 US Island,6 WW Standard,7 Shipping By Platform
 */
function buildShippings(orderObj = {}, item = {}) {
  const platformLabel = safeStr(orderObj.platform_label || orderObj.platformLabel || "");
  if (platformLabel.trim() !== "") return [7]; // theo spec: có platform_label => Shipping By Platform

  // ưu tiên nếu upstream có codes
  const rawCodes = item.shippings || orderObj.shippings;
  if (Array.isArray(rawCodes) && rawCodes.length) {
    return rawCodes.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  }

  // derive từ orderObj.shipping_type (mẫu: "Standard")
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
  // design_sku: theo spec là SKU design; với hệ thống bạn, item.sku là seller SKU hợp lý để làm design_sku
  const designSku = safeStr(item.design_sku || item.designSku || item.sku || "");

  // product_sku: theo spec là variant SKU từ Lenful list
  // order mẫu: item.cost_breakdown.matchedSku = "SW-18000-BLK-L"
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

  const requestClone =
    typeof item.request_clone === "boolean"
      ? item.request_clone
      : typeof item.requestClone === "boolean"
        ? item.requestClone
        : false;

  return {
    design_sku: designSku,
    product_sku: productSku,
    quantity: Number(item.quantity || 1),
    mockups,
    designs: designs.map((d) => ({
      position: d.position,
      link: d.link,
      ...(d.link_blueprint ? { link_blueprint: d.link_blueprint } : {}),
    })),
    // embroidery: chỉ gửi khi bạn có nguồn embroidereds; order mẫu hiện không có nên omit
    request_clone: requestClone,
    shippings: buildShippings(orderObj, item),
  };
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

/* -------------------- Preflight validation -------------------- */
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

      if (!Array.isArray(it.designs) || it.designs.length === 0) {
        errors.push(`items[${idx}].designs is required (min 1)`);
      } else {
        it.designs.forEach((d, j) => {
          if (typeof d?.position !== "number") errors.push(`items[${idx}].designs[${j}].position must be number`);
          need(`items[${idx}].designs[${j}].link`, d?.link);
          if (d?.link && !isUrl(d.link)) errors.push(`items[${idx}].designs[${j}].link is not a valid URL`);
        });
      }

      // rule: nếu platform_label có giá trị => shippings bắt buộc là Shipping By Platform (7)
      if (String(p.platform_label || "").trim() !== "") {
        if (!Array.isArray(it.shippings) || !it.shippings.includes(7)) {
          errors.push(`items[${idx}].shippings must include 7 when platform_label is present`);
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
      return { ok: true, externalId: pickExternalId(body), normalized: { success: true, message: msg || "OK", data: body.data || body } };
    }
    const err = new Error(msg || "Lenful: Non-success response");
    err.code = "LENFUL_NON_SUCCESS";
    err.vendorResponse = body;
    return { ok: false, error: err };
  }

  if (!Number.isNaN(statusNum)) {
    if (statusNum >= 200 && statusNum < 300) {
      return { ok: true, externalId: pickExternalId(body), normalized: { status: statusNum, message: msg || "OK", data: body.data || body } };
    }
    const err = new Error(msg || "Lenful: Error");
    err.code = "LENFUL_NON_SUCCESS";
    err.vendorResponse = body;
    return { ok: false, error: err };
  }

  if (body && (body.id || body.order_number || body.orderNo)) {
    return { ok: true, externalId: body.order_number || body.orderNo || body.id || null, normalized: { message: msg || "OK (soft)", data: body, soft: true } };
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

  const pre = validatePayload(payload);
  if (!pre.ok) {
    const err = new Error(`Lenful payload validation failed: ${pre.errors.join("; ")}`);
    err.code = "LENFUL_PREVALIDATION_FAILED";
    err.details = pre.errors;
    throw err;
  }

  const endpoint =
    process.env.LENFUL_ENDPOINT ||
    "https://<LENFUL_HOST>/api/.../orders"; // <-- thay endpoint thật

  const apiKey =
    process.env.LENFUL_API_KEY ||
    process.env.LENFUL_ACCESS_TOKEN ||
    "";

  if (!apiKey) {
    const err = new Error("Missing LENFUL_API_KEY in environment");
    err.code = "LENFUL_MISSING_API_KEY";
    throw err;
  }

  // Nếu Lenful yêu cầu X-API-Key giống Mango: đổi sang "X-API-Key": apiKey
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

    // soft-success handling
    if (data && typeof data === "object") {
      const msg = String(data?.message || "").toLowerCase();
      const looksLikeSuccess =
        msg.includes("created") ||
        msg.includes("success") ||
        msg.includes("already exist") ||
        msg.includes("already created");

      if (looksLikeSuccess) {
        const parsedSoft = parseResponseForLenful(data);
        if (parsedSoft.ok) return { data, externalId: parsedSoft.externalId, normalized: parsedSoft.normalized };
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
