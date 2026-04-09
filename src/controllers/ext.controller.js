const db = require("../models");
const Shop = db.shop;
const RealtimeLog = db.RealtimeLog;
const OrderCustomProduct = db.orderCustomProduct;

const mongoose = require("mongoose");
const axios = require("axios").default;
const qs = require("querystring");

// Fallback khi db không export
const VendorProduct = db.vendorProduct || mongoose.model("VendorProduct");
const Vendor = db.vendor || mongoose.model("Vendor");

// ====== ENV ======
const {
  NODE_ENV = "development",

  // Beeful (Grabink)
  GRABINK_API_KEY = "",

  // MerchFox
  MERCHFOX_TOKENKEY = "",
  MERCHFOX_SECRET = "",

  // Merchize
  MERCHIZE_ACCESS_TOKEN = "",

  // MangoTee
  // .env: MANGOTEE_ENDPOINT=https://v3.mangoteeprints.com/api/public/v1/orders
  MANGOTEE_ENDPOINT = "https://v3.mangoteeprints.com/api/public/v1/orders",
  MANGOTEE_API_KEY = "",

  // Printway
  // .env:
  // PRINTWAY_ENDPOINT=https://apis.printway.io/v3/order/create-new-order
  // PRINTWAY_PAID_ENDPOINT = https://apis.printway.io/v3/order/paid
  PRINTWAY_ENDPOINT = "https://apis.printway.io/v3/order/create-new-order",
  PRINTWAY_PAID_ENDPOINT = "https://apis.printway.io/v3/order/paid",
  PRINTWAY_ACCESS_TOKEN = "",

  // SS88 (mmoseller)
  // .env: SS88_API_KEY=<your_api_key>
  SS88_API_KEY = "",

  // Debug flag cho server (tuỳ set)
  VENDOR_SYNC_DEBUG = "0",
} = process.env;

const DEBUG = VENDOR_SYNC_DEBUG === "1";

// Tách host/baseUrl từ endpoint có sẵn trong .env
// MangoTee: from ".../api/public/v1/orders" -> base ".../api/public/v1"
const MANGOTEE_BASE_URL = MANGOTEE_ENDPOINT.replace(/\/orders\/?$/, "");

// Printway detail: from ".../create-new-order" -> ".../detail"
const PRINTWAY_DETAIL_BASE_URL = PRINTWAY_ENDPOINT.replace(
  "/create-new-order",
  "/detail"
).replace(/\/+$/, "");

// ====== HTTP CLIENTS ======
const httpBeeful = axios.create({
  baseURL: "https://be.grabink.co",
  timeout: 20000,
  validateStatus: () => true,
});

const httpMerchFox = axios.create({
  baseURL: "https://api.mymerchfox.com",
  timeout: 20000,
  validateStatus: () => true,
});

const httpMerchize = axios.create({
  baseURL: "https://bo-group-1-2.merchize.com/403c7ev/bo-api",
  timeout: 20000,
  headers: {
    Authorization: `Bearer ${MERCHIZE_ACCESS_TOKEN}`,
    Accept: "application/json",
  },
  validateStatus: () => true,
});

const httpPrintway = axios.create({
  baseURL: PRINTWAY_DETAIL_BASE_URL, // /v3/order/detail
  timeout: 20000,
  headers: {
    "pw-access-token": PRINTWAY_ACCESS_TOKEN,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
  validateStatus: () => true,
});

const httpMangoTee = axios.create({
  baseURL: MANGOTEE_BASE_URL, // e.g., https://v3.mangoteeprints.com/api/public/v1
  timeout: 20000,
  headers: {
    "X-API-Key": MANGOTEE_API_KEY,
    Accept: "application/json",
  },
  validateStatus: () => true,
});

const httpSS88 = axios.create({
  baseURL: "https://mmoseller.com/api/external",
  timeout: 20000,
  headers: {
    "X-API-Key": SS88_API_KEY,
    Accept: "application/json",
  },
  validateStatus: () => true,
});

// ====== HELPERS ======
const norm = (s) => String(s || "").trim();
const lower = (s) => norm(s).toLowerCase();

function isValidTrackingNumber(s) {
  const t = norm(s);
  if (!t) return false;
  if (t === "-" || t === "---") return false;
  if (/^0+$/.test(t)) return false;
  if (!/[A-Za-z0-9]/.test(t)) return false;
  if (t.length < 8) return false;
  return true;
}

function normalizeVendorKey(nameOrType) {
  const s = lower(nameOrType);
  if (!s) return "";
  if (s.includes("beeful") || s.includes("grabink")) return "beeful";
  if (s.includes("merchfox") || s.includes("merch fox")) return "merchfox";
  if (s.includes("merchize")) return "merchize";
  if (s.includes("printway") || s.includes("print way") || s === "pw")
    return "printway";
  if (
    s.includes("mangotee") ||
    s.includes("mango tee") ||
    s.includes("mangoteeprints")
  )
    return "mangotee";
  if (s.includes("ss88") || s.includes("mmoseller")) return "ss88";
  if (["beeful", "merchfox", "merchize", "printway", "mangotee", "ss88"].includes(s))
    return s;
  return "";
}

/**
 * Prefetch mapping: vendorProductId -> { vendorKey, vendorName }
 */
async function buildVendorMapsFromVpidSet(vpidSet) {
  const vpids = Array.from(vpidSet);
  if (vpids.length === 0) return new Map();

  const vps = await VendorProduct.find({ _id: { $in: vpids } })
    .select({ _id: 1, vendor_id: 1 })
    .lean();

  const vendorIds = [...new Set(vps.map((vp) => vp.vendor_id).filter(Boolean))];
  const vendors = vendorIds.length
    ? await Vendor.find({ _id: { $in: vendorIds } })
      .select({ _id: 1, name: 1, fulfillment_type: 1 })
      .lean()
    : [];

  const vendorMap = new Map(vendors.map((v) => [String(v._id), v]));
  const vpidToVendor = new Map();

  for (const vp of vps) {
    const vend = vendorMap.get(String(vp.vendor_id));
    const vendorKey =
      normalizeVendorKey(vend?.fulfillment_type) ||
      normalizeVendorKey(vend?.name);
    vpidToVendor.set(String(vp._id), {
      vendorKey,
      vendorName: vend?.name || "",
    });
  }
  return vpidToVendor;
}

/**
 * Group item index theo vendorKey dùng map đã prefetch
 */
function groupItemsByVendorWithMap(doc, vpidToVendor) {
  const groups = {};
  for (let i = 0; i < (doc.items || []).length; i++) {
    const it = doc.items[i];
    const vpid = it?.cost_breakdown?.vendorProductId;
    const info = vpid ? vpidToVendor.get(String(vpid)) : null;
    const key = info?.vendorKey || "unknown";
    if (!groups[key]) groups[key] = { itemIndexes: [] };
    groups[key].itemIndexes.push(i);
  }
  return groups;
}

// ====== VENDOR FETCHERS ======
async function fetchBeeful(orderId) {
  const url = `/api/external/order/${encodeURIComponent(orderId)}`;
  const res = await httpBeeful.get(url, {
    params: { api_key: GRABINK_API_KEY },
  });
  if (DEBUG)
    console.log(
      "[Beeful][HTTP]",
      res.status,
      "| keys:",
      Object.keys(res.data || {})
    );
  if (!res.data || typeof res.data !== "object")
    throw new Error(`Beeful empty (HTTP ${res.status})`);
  if (
    res.status >= 400 ||
    res.data?.message === "Not Found" ||
    res.data?.error
  ) {
    throw new Error(
      `Beeful error: ${res.data?.message || res.data?.error || res.status}`
    );
  }
  const raw = res.data;
  const tracking =
    norm(raw?.tracking?.trackingNumber) || norm(raw?.trackingId) || "";
  const carrier = norm(raw?.shippingProvider);
  const shipped = lower(raw?.status) === "shipped" || Boolean(tracking);
  return { tracking, carrier, shipped, raw };
}

function parseMerchFoxResp(orderId, res) {
  const { status } = res;
  let raw = res.data;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      const head = raw.slice(0, 300).replace(/\s+/g, " ");
      throw new Error(`[MerchFox ${status}] Non-JSON for ${orderId}: ${head}`);
    }
  }
  if (!raw || typeof raw !== "object")
    throw new Error(`MerchFox bad JSON (HTTP ${status})`);
  if (status >= 400)
    throw new Error(
      `MerchFox HTTP ${status}: ${raw.message || raw.error || "Error"}`
    );
  if (raw.code !== 0 || !raw.data)
    throw new Error(
      `MerchFox API code=${raw.code}: ${raw.message || "Unknown"}`
    );
  return raw.data;
}

async function fetchMerchFox(orderId) {
  const url = "/storeapi/v2/order/detail";

  // TRY 1: GET + body form
  const res1 = await httpMerchFox.request({
    method: "get",
    url,
    headers: {
      tokenkey: MERCHFOX_TOKENKEY,
      secret: MERCHFOX_SECRET,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    data: qs.stringify({ mfid: orderId }),
    transformResponse: [(d) => d],
  });
  if (DEBUG) console.log("[MerchFox][TRY GET+BODY]", res1.status);
  try {
    const data = parseMerchFoxResp(orderId, res1);

    const rawTracking = norm(data?.tracking?.number);
    const tracking = isValidTrackingNumber(rawTracking) ? rawTracking : "";
    const carrier = norm(data?.tracking?.carrier);
    const shipped = Boolean(tracking);

    return { tracking, carrier, shipped, raw: data };
  } catch (_) {
    // TRY 2: fallback GET?mfid=
    const res2 = await httpMerchFox.get(url, {
      headers: {
        tokenkey: MERCHFOX_TOKENKEY,
        secret: MERCHFOX_SECRET,
        Accept: "application/json",
      },
      params: { mfid: orderId },
      transformResponse: [(d) => d],
    });
    if (DEBUG) console.log("[MerchFox][TRY GET?mfid=]", res2.status);

    const data = parseMerchFoxResp(orderId, res2);

    const rawTracking = norm(data?.tracking?.number);
    const tracking = isValidTrackingNumber(rawTracking) ? rawTracking : "";
    const carrier = norm(data?.tracking?.carrier);
    const shipped = Boolean(tracking);

    return { tracking, carrier, shipped, raw: data };
  }
}

async function fetchMerchize(orderId) {
  // 1) Ưu tiên endpoint tracking
  let res = await httpMerchize.get("/order/external/orders/tracking", {
    params: { external_number: orderId },
  });
  if (DEBUG)
    console.log(
      "[Merchize][HTTP tracking]",
      res.status,
      "| keys:",
      Object.keys(res.data || {})
    );
  if (res.status >= 400)
    throw new Error(`Merchize HTTP ${res.status} (tracking)`);

  if (
    res.data?.success === true &&
    Array.isArray(res.data.data) &&
    res.data.data.length > 0
  ) {
    const obj = res.data.data[0];
    const tracking = norm(obj?.tracking_number);
    const carrier = norm(obj?.tracking_company);
    const shipped = isValidTrackingNumber(tracking);

    return { tracking, carrier, shipped, raw: obj };
  }

  // 2) Fallback: order-detail
  res = await httpMerchize.get("/order/external/orders/order-detail", {
    params: { external_number: orderId },
  });
  if (DEBUG)
    console.log(
      "[Merchize][HTTP detail]",
      res.status,
      "| keys:",
      Object.keys(res.data || {})
    );
  if (res.status >= 400)
    throw new Error(`Merchize HTTP ${res.status} (detail)`);

  if (
    res.data?.success === true &&
    Array.isArray(res.data.data) &&
    res.data.data.length > 0
  ) {
    const obj = res.data.data[0];
    const tracking = norm(obj?.tracking_number);
    const carrier = norm(obj?.tracking_company);
    const shipped = isValidTrackingNumber(tracking);

    return { tracking, carrier, shipped, raw: obj };
  }

  throw new Error(`Merchize empty for ${orderId}`);
}

function _pwPickLatest(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list
    .map((t) => ({
      trackingNumber: (t?.trackingNumber ?? t?.tracking_number ?? "").trim(),
      trackingUrl: (t?.trackingUrl ?? t?.tracking_url ?? "").trim(),
      carrierName: (
        t?.carrierName ??
        t?.carrier ??
        t?.carrierCode ??
        ""
      ).trim(),
      updatedAtMs: new Date(t?.updatedAt ?? t?.updated_at ?? 0).getTime(),
    }))
    .sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))[0];
}

/**
 * Printway v3 only (/v3/order/detail)
 */
async function fetchPrintway(orderId, doc) {
  const tries = [];

  // 1) order_name = Amazon orderId
  tries.push({ body: { order_name: orderId } });

  // 2) pw_order_id từ cache
  const cachedPwid = norm(doc?.printway_submission?.pw_order_id);
  if (cachedPwid) tries.push({ body: { pw_order_id: cachedPwid } });

  // 3) nếu orderId dạng PWxxxxx thì thử làm pw_order_id
  if (/^PW\d+/i.test(orderId)) tries.push({ body: { pw_order_id: orderId } });

  let lastErr = null;

  for (const t of tries) {
    const res = await httpPrintway.request({
      method: "get",
      url: "", // baseURL đã trỏ /v3/order/detail
      params: t.body,
      transformResponse: [(d) => d], // giữ raw string để tự parse
    });

    if (DEBUG)
      console.log("[Printway v3][HTTP]", res.status, "| body:", t.body);

    if (res.status >= 400) {
      lastErr = new Error(`Printway v3 HTTP ${res.status}`);
      continue;
    }

    let raw;
    try {
      raw = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    } catch {
      lastErr = new Error("Printway v3 non-JSON payload");
      continue;
    }

    if (!raw || typeof raw !== "object") {
      lastErr = new Error("Printway v3 empty payload");
      continue;
    }

    // Chuẩn hóa về list orders
    let orders = [];
    if (Array.isArray(raw.data)) {
      orders = raw.data;
    } else if (raw.data && typeof raw.data === "object") {
      orders = [raw.data];
    } else if (Array.isArray(raw)) {
      orders = raw;
    } else {
      orders = [raw];
    }

    if (!orders.length) {
      lastErr = new Error("Printway v3 empty data list");
      continue;
    }

    const combined = [];

    for (const ord of orders) {
      if (Array.isArray(ord.trackings)) {
        combined.push(...ord.trackings);
      }
      if (Array.isArray(ord.orderitems)) {
        for (const it of ord.orderitems) {
          if (it?.tracking) combined.push(it.tracking);
        }
      }
    }

    const latest = _pwPickLatest(combined);
    const firstOrder = orders[0];

    if (!latest) {
      // Có order nhưng chưa có tracking
      return { tracking: "", carrier: "", shipped: false, raw: firstOrder };
    }

    const tracking = latest.trackingNumber || "";
    const carrier = latest.carrierName || "";
    const shipped = Boolean(tracking);

    return { tracking, carrier, shipped, raw: firstOrder };
  }

  throw lastErr || new Error("Printway v3 unknown error");
}


/**
 * MangoTee helpers
 */
function _mtPickLatestEvent(events) {
  if (!Array.isArray(events) || events.length === 0) return null;

  const primary = events.filter((e) => e && e.primary === true);
  const pool = primary.length ? primary : events;

  return pool
    .map((e) => ({
      trackingNumber: norm(e.tracking_number || e.trackingNumber || ""),
      carrierName: norm(e.carrier || ""),
      trackingUrl: norm(e.tracking_url || e.trackingUrl || ""),
      createdAtMs: new Date(e.created_at || e.updated_at || 0).getTime(),
    }))
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))[0];
}

async function fetchMangoTee(orderId) {
  if (!MANGOTEE_API_KEY) throw new Error("MangoTee missing API key");
  const url = `/orders/${encodeURIComponent(orderId)}`;

  const res = await httpMangoTee.get(url);
  if (DEBUG) console.log("[MangoTee][HTTP]", res.status);

  if (res.status >= 400) throw new Error(`MangoTee HTTP ${res.status}`);

  const raw = res.data;
  if (!raw || typeof raw !== "object")
    throw new Error("MangoTee empty payload");
  if (raw.status !== true || raw.code !== "SUCCESS" || !raw.data) {
    throw new Error(`MangoTee bad response: code=${raw.code}`);
  }

  const data = raw.data;

  let tracking = norm(data.tracking_number);
  if (!isValidTrackingNumber(tracking)) tracking = "";

  let carrier = "";
  const ev = _mtPickLatestEvent(data.events || []);
  if (ev) {
    if (!tracking && isValidTrackingNumber(ev.trackingNumber))
      tracking = ev.trackingNumber;
    carrier = ev.carrierName || carrier;
  }

  const shipped =
    lower(data.status) === "shipped" ||
    lower(data.production_status) === "fulfilled" ||
    Boolean(tracking);

  return { tracking, carrier, shipped, raw };
}

/**
 * SS88 (mmoseller.com)
 * GET https://mmoseller.com/api/external/orders/{orderId}
 * Tracking lấy từ data.trackingNumber (order-level),
 * nếu null thì tìm trong data.items[*].trackingNumber
 */
async function fetchSS88(orderId) {
  if (!SS88_API_KEY) throw new Error("SS88 missing API key (SS88_API_KEY)");

  const url = `/orders/${encodeURIComponent(orderId)}`;
  const res = await httpSS88.get(url);

  if (DEBUG) console.log("[SS88][HTTP]", res.status);

  if (res.status >= 400)
    throw new Error(`SS88 HTTP ${res.status} for ${orderId}`);

  const raw = res.data;
  if (!raw || typeof raw !== "object")
    throw new Error("SS88 empty payload");
  if (raw.success !== true || !raw.data)
    throw new Error(`SS88 bad response: success=${raw.success}`);

  const data = raw.data;

  // Lấy trackingNumber từ order-level trước, nếu không có thì tìm trong items
  let tracking = norm(data.trackingNumber);
  if (!isValidTrackingNumber(tracking)) {
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const t = norm(item.trackingNumber);
      if (isValidTrackingNumber(t)) {
        tracking = t;
        break;
      }
    }
  }
  if (!isValidTrackingNumber(tracking)) tracking = "";

  const carrier = norm(data.carrier);
  const shipped =
    lower(data.status) === "shipped" ||
    lower(data.status) === "delivered" ||
    Boolean(tracking);

  return { tracking, carrier, shipped, raw: data };
}

// ====== APPLY RESULT INTO ORDER DOC ======
function applyToItemsOfVendor(
  doc,
  vendorKey,
  { tracking, carrier, shipped, raw }
) {
  let changed = 0;

  doc.items = (doc.items || []).map((it) => {
    const vpid = it?.cost_breakdown?.vendorProductId;
    const cached = vpid ? doc.__vpidToVendor?.get(String(vpid)) : null;
    const thisVendorKey = cached?.vendorKey || "";

    if (thisVendorKey !== vendorKey) {
      return it.toObject?.() ? it.toObject() : it;
    }

    const ti = it.tracking_info || {};
    const prevTracking = norm(ti.tracking);
    const thePrevStatus = norm(ti.status);

    const nextTI = {
      ...ti,
      fulfillment:
        vendorKey === "beeful"
          ? "Beeful"
          : vendorKey === "merchfox"
            ? "MerchFox"
            : vendorKey === "merchize"
              ? "Merchize"
              : vendorKey === "printway"
                ? "Printway"
                : vendorKey === "mangotee"
                  ? "MangoTee"
                  : vendorKey === "ss88"
                    ? "SS88"
                    : norm(ti.fulfillment),
      tracking: tracking || prevTracking,
      status: shipped ? "Shipped" : thePrevStatus || "New",
      updated_at: new Date(),
      note: [norm(ti.note), carrier && `carrier:${carrier}`]
        .filter(Boolean)
        .join(" | "),
    };

    if (
      nextTI.tracking !== prevTracking ||
      nextTI.status !== thePrevStatus ||
      nextTI.fulfillment !== ti.fulfillment ||
      nextTI.note !== ti.note
    ) {
      changed++;
    }

    return { ...(it.toObject?.() ? it.toObject() : it), tracking_info: nextTI };
  });

  if (vendorKey === "beeful") {
    doc.beeful_submission = {
      ...(doc.beeful_submission || {}),
      attempt_count: (doc.beeful_submission?.attempt_count || 0) + 1,
      last_response: raw,
    };
  } else if (vendorKey === "merchfox") {
    doc.merchfox_submission = {
      ...(doc.merchfox_submission || {}),
      attempt_count: (doc.merchfox_submission?.attempt_count || 0) + 1,
      last_response: raw,
      mfid: doc.orderId,
    };
  } else if (vendorKey === "merchize") {
    doc.merchize_submission = {
      ...(doc.merchize_submission || {}),
      attempt_count: (doc.merchize_submission?.attempt_count || 0) + 1,
      last_response: raw,
    };
  } else if (vendorKey === "printway") {
    doc.printway_submission = {
      ...(doc.printway_submission || {}),
      attempt_count: (doc.printway_submission?.attempt_count || 0) + 1,
      last_response: raw,
      pw_order_id: norm(raw?.order?.pw_order_id),
      order_name: norm(raw?.order?.order_name),
    };
  } else if (vendorKey === "mangotee") {
    doc.mangotee_submission = {
      ...(doc.mangotee_submission || {}),
      attempt_count: (doc.mangotee_submission?.attempt_count || 0) + 1,
      last_response: raw,
      order_id: norm(raw?.data?.order_id),
      mt_status: norm(raw?.data?.status || raw?.data?.production_status),
    };
  } else if (vendorKey === "ss88") {
    doc.ss88_submission = {
      ...(doc.ss88_submission || {}),
      attempt_count: (doc.ss88_submission?.attempt_count || 0) + 1,
      last_response: raw,
      ss88_id: norm(raw?.id),
      ss88_status: norm(raw?.status),
    };
  }

  return changed;
}

async function updateOrderByVendors(orderId, vpidToVendorPrefetched = null) {
  const doc = await OrderCustomProduct.findOne({ orderId: orderId.trim() });
  if (!doc) throw new Error(`Order not found in DB: ${orderId}`);

  let vpidSet = new Set();
  for (const it of doc.items || []) {
    const vpid = it?.cost_breakdown?.vendorProductId;
    if (vpid) vpidSet.add(String(vpid));
  }
  const vpidToVendor =
    vpidToVendorPrefetched || (await buildVendorMapsFromVpidSet(vpidSet));

  doc.__vpidToVendor = vpidToVendor;

  const groups = groupItemsByVendorWithMap(doc, vpidToVendor);
  const vendorKeys = Object.keys(groups).filter((k) =>
    ["beeful", "merchfox", "merchize", "printway", "mangotee", "ss88"].includes(k)
  );

  // --- DIAGNOSTIC LOG (xoá sau khi debug xong) ---
  console.log(`[DIAG][${orderId}] vpidSet=`, [...vpidSet]);
  console.log(`[DIAG][${orderId}] vpidToVendor=`, [...vpidToVendor.entries()]);
  console.log(`[DIAG][${orderId}] groups=`, JSON.stringify(groups));
  console.log(`[DIAG][${orderId}] vendorKeys=`, vendorKeys);
  for (const it of doc.items || []) {
    console.log(`[DIAG][${orderId}] item tracking_info=`, JSON.stringify(it?.tracking_info));
  }
  // --- END DIAGNOSTIC LOG ---

  if (vendorKeys.length === 0) {
    throw new Error(
      `No known vendor mapping from items.cost_breakdown.vendorProductId for ${orderId}`
    );
  }

  let totalChanged = 0;
  for (const vk of vendorKeys) {
    try {
      let res;
      if (vk === "beeful") res = await fetchBeeful(orderId);
      else if (vk === "merchfox") res = await fetchMerchFox(orderId);
      else if (vk === "merchize") res = await fetchMerchize(orderId);
      else if (vk === "printway") res = await fetchPrintway(orderId, doc);
      else if (vk === "mangotee") res = await fetchMangoTee(orderId);
      else if (vk === "ss88") res = await fetchSS88(orderId);
      else continue;

      totalChanged += applyToItemsOfVendor(doc, vk, res);
    } catch (e) {
      console.error(`[VENDOR FAIL][${vk}] ${orderId}:`, e.message);
    }
  }

  const allShipped = (doc.items || []).every(
    (it) => lower(it?.tracking_info?.status) === "shipped"
  );
  let orderStatusChanged = false;
  if (allShipped && doc.status !== "Shipped") {
    doc.status = "Shipped";
    orderStatusChanged = true;
  }

  await doc.save();
  return { updatedItems: totalChanged, orderStatusChanged };
}

async function runBatch({ max = 100, dryRun = false } = {}) {
  console.log(`🔍 [BATCH] Starting batch processing with max=${max}, dryRun=${dryRun}`);
  
  const candidates = await OrderCustomProduct.find({
    status: { $ne: "Shipped" },
    "items.cost_breakdown.vendorProductId": { $exists: true, $ne: null },
  })
    .sort({ createdAt: -1 })
    .limit(max)
    .lean();

  console.log(`📋 [BATCH] Found ${candidates.length} candidate orders`);

  const vpidSet = new Set();
  for (const o of candidates) {
    for (const it of o.items || []) {
      const vpid = it?.cost_breakdown?.vendorProductId;
      if (vpid) vpidSet.add(String(vpid));
    }
  }
  
  console.log(`🔗 [BATCH] Building vendor maps for ${vpidSet.size} vendor products`);
  const vpidToVendor = await buildVendorMapsFromVpidSet(vpidSet);

  const knownKeys = new Set([
    "beeful",
    "merchfox",
    "merchize",
    "printway",
    "mangotee",
    "ss88",
  ]);
  const filtered = candidates.filter((o) => {
    const groups = groupItemsByVendorWithMap(o, vpidToVendor);
    return Object.keys(groups).some((k) => knownKeys.has(k));
  });

  console.log(`✅ [BATCH] Filtered to ${filtered.length} orders with known vendors`);

  if (dryRun) {
    console.log(`🧪 [BATCH] DRY RUN mode - returning order list without processing`);
    return {
      ok: true,
      mode: "dry-run",
      scanned: filtered.length,
      orderIds: filtered.map((o) => o.orderId),
      vendorsPerOrder: filtered.map((o) => {
        const g = groupItemsByVendorWithMap(o, vpidToVendor);
        return {
          orderId: o.orderId,
          vendorKeys: Object.keys(g).filter((k) => knownKeys.has(k)),
        };
      }),
    };
  }

  console.log(`🚀 [BATCH] Processing ${filtered.length} orders...`);
  let ok = 0,
    fail = 0;
  for (const o of filtered) {
    try {
      const r = await updateOrderByVendors(o.orderId, vpidToVendor);
      if (DEBUG || NODE_ENV !== "test") {
        console.log(
          `✅ [BATCH] ${o.orderId} | itemsChanged=${r.updatedItems} | orderStatusChanged=${r.orderStatusChanged}`
        );
      }
      ok++;
    } catch (err) {
      console.error(`❌ [BATCH] ${o.orderId}: ${err.message}`);
      fail++;
    }
  }
  
  console.log(`🏁 [BATCH] Completed: ${ok} success, ${fail} failed, ${filtered.length} total`);
  return { ok, fail, scanned: filtered.length };
}

// ====== API HANDLERS CHO VENDOR SYNC ======

/**
 * POST /api/vendor-sync/one
 * body: { orderId: "xxx" }
 */
const vendorSyncOne = async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ ok: false, message: "orderId required" });
    }
    const result = await updateOrderByVendors(orderId);
    return res.json({ ok: true, orderId, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};

/**
 * POST /api/vendor-sync/list
 * body: { orderIds: ["...", "..."] }
 */
const vendorSyncList = async (req, res) => {
  try {
    const { orderIds = [] } = req.body || {};
    if (!Array.isArray(orderIds) || !orderIds.length) {
      return res
        .status(400)
        .json({ ok: false, message: "orderIds[] required" });
    }

    let ok = 0,
      fail = 0;
    const details = [];

    for (const id of orderIds) {
      try {
        const r = await updateOrderByVendors(id);
        details.push({ orderId: id, ok: true, ...r });
        ok++;
      } catch (err) {
        details.push({ orderId: id, ok: false, message: err.message });
        fail++;
      }
    }

    return res.json({
      ok: true,
      summary: { ok, fail, scanned: orderIds.length },
      details,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};

/**
 * POST /api/vendor-sync/batch
 * body: { max?: number, dryRun?: boolean }
 */
const vendorSyncBatch = async (req, res) => {
  const startTime = new Date();
  const isAutoCall = !req.headers['user-agent']; // Auto calls không có user-agent
  
  try {
    const { max = 100, dryRun = false } = req.body || {};
    
    // Log bắt đầu
    console.log(`🚀 [VENDOR-SYNC][${startTime.toISOString()}] Starting vendorSyncBatch`);
    console.log(`📋 [VENDOR-SYNC] Type: ${isAutoCall ? '🤖 AUTO' : '👤 MANUAL'}`);
    console.log(`📋 [VENDOR-SYNC] Config: max=${max}, dryRun=${dryRun}`);
    
    const result = await runBatch({
      max: Number(max) || 100,
      dryRun: Boolean(dryRun),
    });
    
    const endTime = new Date();
    const duration = endTime - startTime;
    
    // Log kết quả
    console.log(`✅ [VENDOR-SYNC][${endTime.toISOString()}] Completed successfully`);
    console.log(`📊 [VENDOR-SYNC] Results: ok=${result.ok}, fail=${result.fail}, scanned=${result.scanned}`);
    console.log(`⏱️  [VENDOR-SYNC] Duration: ${duration}ms`);
    
    if (result.mode === 'dry-run') {
      console.log(`🧪 [VENDOR-SYNC] DRY RUN - Orders found: ${result.orderIds?.length || 0}`);
    }
    
    return res.json({ ok: true, processedOrders: result.scanned, ...result });
  } catch (e) {
    const endTime = new Date();
    const duration = endTime - startTime;
    
    // Log lỗi
    console.error(`❌ [VENDOR-SYNC][${endTime.toISOString()}] Failed after ${duration}ms`);
    console.error(`❌ [VENDOR-SYNC] Error: ${e.message}`);
    console.error(`❌ [VENDOR-SYNC] Stack:`, e.stack);
    
    return res.status(500).json({ ok: false, message: e.message });
  }
};

// ===================================================================
// ========== CÁC HÀM CŨ: requestExtension / getClientOnline ==========
// ===================================================================

const pullAllOrder = async (req, res) => {
  const { action = "click", label = null, type, payload } = req.body || {};

  const io = req.app.get("io");
  if (!io) return res.status(500).json({ ok: false, message: "io missing" });

  const task = { type: type, payload: payload };

  io.emit("server:task", task);

  const recipients = io.of("/").sockets.size || 0;

  await RealtimeLog.create({
    label: "All Clients",
    action,
    level: "info",
    message: `Start import orders for ${recipients} client...`,
    ts: new Date(),
  });

  return res.status(202).json({
    ok: true,
    recipients,
    message: "Broadcast IMPORT_ORDERS to all connected extensions",
  });
};

async function requestExtension(req, res) {
  const startTime = new Date();
  const isAutoCall = !req.headers['user-agent']; // Auto calls không có user-agent
  
  try {
    const {
      shopId,
      machineId,
      action = "click",
      label = null,
      type,
      payload,
    } = req.body || {};
    
    // Log bắt đầu
    console.log(`🚀 [REQUEST-EXT][${startTime.toISOString()}] Starting requestExtension`);
    console.log(`📋 [REQUEST-EXT] Type: ${isAutoCall ? '🤖 AUTO' : '👤 MANUAL'}`);
    console.log(`📋 [REQUEST-EXT] Shop: ${shopId}, Machine: ${machineId}, Task: ${type}`);
    
    if (!shopId || !machineId) {
      console.log(`❌ [REQUEST-EXT] Missing required fields: shopId=${shopId}, machineId=${machineId}`);
      return res
        .status(400)
        .json({ ok: false, message: "shopId & machineId required" });
    }

    const io = req.app.get("io");
    if (!io) {
      console.error(`❌ [REQUEST-EXT] Socket.IO not available`);
      return res.status(500).json({ ok: false, message: "io missing" });
    }

    const task = { type: type, payload: payload };

    console.log(`📤 [REQUEST-EXT] Sending task to machine:${machineId}`, { type, payload });
    io.to(`machine:${machineId}`).emit("server:task", task);

    let message = "";

    switch (type) {
      case "IMPORT_ORDERS":
        message = "Start import orders ...";
        break;
      case "IMPORT_ADS_SPEND":
        message = "Start import ads ...";
        break;
      case "IMPORT_FBM_ORDERS":
        message = "Start import FBM orders ...";
        break;
      default:
        message = `Start ${type} ...`;
        break;
    }

    console.log(`📝 [REQUEST-EXT] Creating RealtimeLog: ${message}`);
    await RealtimeLog.create({
      shopId,
      machineId,
      label,
      action,
      level: "info",
      message: message,
      ts: new Date(),
    });

    const endTime = new Date();
    const duration = endTime - startTime;
    
    console.log(`✅ [REQUEST-EXT][${endTime.toISOString()}] Completed successfully`);
    console.log(`⏱️  [REQUEST-EXT] Duration: ${duration}ms`);

    return res.json({ ok: true });
  } catch (e) {
    const endTime = new Date();
    const duration = endTime - startTime;
    
    console.error(`❌ [REQUEST-EXT][${endTime.toISOString()}] Failed after ${duration}ms`);
    console.error(`❌ [REQUEST-EXT] Error: ${e.message}`);
    console.error(`❌ [REQUEST-EXT] Stack:`, e.stack);
    
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/**
 * POST /api/request-extension/auto-all
 * body: { type, payload, action?, label? }
 * Auto request extension cho tất cả shops
 */
const autoRequestExtensionAll = async (req, res) => {
  const startTime = new Date();
  const isAutoCall = !req.headers['user-agent']; // Auto calls không có user-agent
  
  try {
    const { type, payload, action = "auto", label = "Auto Request" } = req.body || {};
    
    if (!type) {
      return res.status(400).json({ ok: false, message: "type required" });
    }

    // Log bắt đầu
    console.log(`🚀 [AUTO-REQUEST][${startTime.toISOString()}] Starting autoRequestExtensionAll`);
    console.log(`📋 [AUTO-REQUEST] Type: ${isAutoCall ? '🤖 AUTO' : '👤 MANUAL'}`);
    console.log(`📋 [AUTO-REQUEST] Task: type=${type}, action=${action}`);
    
    // Lấy tất cả shops từ database
    const shops = await Shop.find({ status: { $ne: 'inactive' } })
      .select({ _id: 1, name: 1, store: 1 })
      .lean();
    
    console.log(`📊 [AUTO-REQUEST] Found ${shops.length} active shops`);
    
    if (shops.length === 0) {
      console.log(`⚠️  [AUTO-REQUEST] No active shops found`);
      return res.json({ 
        ok: true, 
        message: "No active shops found",
        processed: 0,
        results: []
      });
    }

    const io = req.app?.get?.("io");
    if (!io) {
      console.error(`❌ [AUTO-REQUEST] Socket.IO not available`);
      return res.status(500).json({ ok: false, message: "Socket.IO not available" });
    }

    const task = { type, payload };
    const results = [];
    let successCount = 0;
    let failCount = 0;

    // Gửi task cho từng shop (shopId = machineId)
    for (const shop of shops) {
      const shopId = String(shop._id);
      const machineId = shopId; // shopId và machineId giống nhau
      const shopName = shop.name || shop.store || `Shop ${shopId}`;
      
      try {
        console.log(`📤 [AUTO-REQUEST] Processing shop: ${shopName} (${shopId})`);
        
        // Gọi requestExtension cho từng shop
        const mockReq = {
          body: {
            shopId,
            machineId,
            action: "auto",
            label,
            type,
            payload
          },
          headers: {}, // Không có user-agent để đánh dấu là auto call
          app: req.app // Truyền app object để có thể get io
        };
        
        const mockRes = {
          json: (data) => data,
          status: (code) => ({
            json: (data) => ({ statusCode: code, ...data })
          })
        };
        
        // Gọi requestExtension trực tiếp
        const { requestExtension } = require("../controllers/ext.controller");
        const result = await requestExtension(mockReq, mockRes);
        
        if (result.ok) {
          results.push({
            shopId,
            shopName,
            success: true,
            message: `Task sent successfully`
          });
          successCount++;
          console.log(`✅ [AUTO-REQUEST] Success: ${shopName}`);
        } else {
          throw new Error(result.message || 'Unknown error');
        }
        
      } catch (error) {
        console.error(`❌ [AUTO-REQUEST] Failed for shop ${shopName}:`, error.message);
        
        results.push({
          shopId,
          shopName,
          success: false,
          message: error.message
        });
        
        failCount++;
      }
    }

    const endTime = new Date();
    const duration = endTime - startTime;
    
    // Log kết quả
    console.log(`✅ [AUTO-REQUEST][${endTime.toISOString()}] Completed`);
    console.log(`📊 [AUTO-REQUEST] Results: success=${successCount}, failed=${failCount}, total=${shops.length}`);
    console.log(`⏱️  [AUTO-REQUEST] Duration: ${duration}ms`);
    
    return res.json({ 
      ok: true,
      processed: shops.length,
      success: successCount,
      failed: failCount,
      results,
      duration: `${duration}ms`
    });
    
  } catch (e) {
    const endTime = new Date();
    const duration = endTime - startTime;
    
    // Log lỗi
    console.error(`❌ [AUTO-REQUEST][${endTime.toISOString()}] Failed after ${duration}ms`);
    console.error(`❌ [AUTO-REQUEST] Error: ${e.message}`);
    
    return res.status(500).json({ ok: false, message: e.message });
  }
};

const getClientOnline = async (req, res) => {
  try {
    const presence = req.app.get("presence");
    const io = req.app.get("io");
    if (!io || !presence) return res.json({ ok: true, clients: [] });

    const {
      shopId: filterShopId,
      machineId: filterMachineId,
      q,
    } = req.query || {};
    const now = Date.now();
    const TTL_MS = Number(process.env.PRESENCE_TTL_MS || 45000);

    const liveSocketIds = new Set(io.of("/").sockets.keys());

    const snap = presence.snapshot() || [];

    const latestByMachine = new Map();
    for (const c of snap) {
      if (!c?.machineId) continue;
      if (filterShopId && String(c.shopId) !== String(filterShopId)) continue;
      if (filterMachineId && String(c.machineId) !== String(filterMachineId))
        continue;

      const prev = latestByMachine.get(String(c.machineId));
      if (!prev || (c.lastSeen || 0) > (prev.lastSeen || 0)) {
        latestByMachine.set(String(c.machineId), c);
      }
    }

    const roomMap = io.of("/").adapter.rooms;
    const candidates = [];
    for (const c of latestByMachine.values()) {
      let sid = c.socketId && liveSocketIds.has(c.socketId) ? c.socketId : null;

      if (!sid && roomMap) {
        const room = roomMap.get(`machine:${c.machineId}`);
        if (room && room.size) {
          for (const anySid of room) {
            if (liveSocketIds.has(anySid)) {
              sid = anySid;
              break;
            }
          }
        }
      }

      if (!sid) continue;

      if (q) {
        const hay = `${c.label || ""} ${c.ua || ""}`.toLowerCase();
        if (!hay.includes(String(q).toLowerCase())) continue;
      }

      candidates.push({ ...c, socketId: sid });
    }

    if (!candidates.length) return res.json({ ok: true, clients: [] });

    const uniqueShopIds = [
      ...new Set(candidates.map((c) => String(c.shopId)).filter(Boolean)),
    ];
    const shops = await Shop.find(
      { _id: { $in: uniqueShopIds } },
      { _id: 1, name: 1, store: 1 }
    ).lean();
    const shopMap = new Map(shops.map((s) => [String(s._id), s]));

    const out = candidates.map((c) => {
      const shop = shopMap.get(String(c.shopId));
      const lastSeenMs = c.lastSeen || now;
      const staleMs = now - lastSeenMs;
      const stale = staleMs > TTL_MS;

      return {
        socketId: c.socketId || null,
        clientId: c.machineId || null,

        machineId: c.machineId || null,
        label: c.label || shop?.name || shop?.store || `Client ${c.machineId}`,
        version: c.version || "",
        ua: c.ua || "",
        ip: c.ip || "",

        shopId: String(c.shopId || ""),
        shopName: shop?.name || shop?.store || String(c.shopId || ""),

        id: `${String(c.shopId)}:${String(c.machineId)}`,

        connectedAt: lastSeenMs,
        lastSeen: lastSeenMs,

        status: stale ? "maybe-online" : "online",
        statusSummary: {
          overall: stale ? "warning" : "success",
          lastTs: lastSeenMs,
          onlineForSec: 0,
          idleForSec: Math.max(0, Math.floor(staleMs / 1000)),
        },
      };
    });

    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = {
  requestExtension,
  getClientOnline,
  pullAllOrder,

  // vendor sync APIs
  vendorSyncOne,
  vendorSyncList,
  vendorSyncBatch,

  // auto request extension
  autoRequestExtensionAll,

  // nếu cần dùng nội bộ
  updateOrderByVendors,
  runBatch,
};
