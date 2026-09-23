const db = require("../models");
const Shop = db.shop;
const RealtimeLog = db.RealtimeLog;
const ExtensionTask = db.ExtensionTask || require("../models/extensionTask.model");
const OrderCustomProduct = db.orderCustomProduct;
const EtsyOrder = db.EtsyOrder;
const taskStatusService = require("../service/taskStatus.service");
const { emitTaskToMachine, buildTaskId } = require("../lib/taskEmitter");
const {
  normalizeVendorTrackingPayload,
} = require("../service/vendorTrackingNormalizer.service");
const { logOrderLifecycleEvent } = require("../service/orderLifecycleLogger");
const { buildOrderLifecyclePayload } = require("../service/orderLifecycleContext");

const mongoose = require("mongoose");
const axios = require("axios").default;
const qs = require("querystring");
const { resolveTrackingReceivedAt } = require("../lib/trackingReceivedAt");
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
  LUXURYPRO_API_KEY = "",
  LUXURYPRO_ACCESS_TOKEN = "",
  LUXURYPRO_TRACKING_ENDPOINT = "",
  LUXURYPRO_DETAIL_ENDPOINT = "",
  LUXURYPRO_ENDPOINT = "",
  LUXURYPRO_AUTH_MODE = "bearer",
  ONOS_API_BASE_URL = "https://api-app.onospod.com/api/v1",
  ONOS_API_KEY = "",
  ONOS_ACCESS_TOKEN = "",
  LENFUL_API_KEY = "",
  LENFUL_ACCESS_TOKEN = "",
  LENFUL_TOKEN = "",

  // Debug flag cho server (tuỳ set)
  VENDOR_SYNC_DEBUG = "0",
} = process.env;

const DEBUG = VENDOR_SYNC_DEBUG === "1";

const getExtensionTask = async (req, res) => {
  try {
    const task = await ExtensionTask.findOne({ taskId: req.params.taskId })
      .select("taskId type shopId machineId status sentAt ackedAt completedAt result lastError resendCount lastResentAt createdAt updatedAt")
      .lean();

    if (!task) return res.status(404).json({ ok: false, message: "Không tìm thấy task" });
    return res.json({ ok: true, data: task });
  } catch (error) {
    console.error("getExtensionTask error:", error);
    return res.status(500).json({ ok: false, message: "Không thể tải lịch sử task" });
  }
};

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

const httpLuxuryPro = axios.create({
  timeout: 20000,
  validateStatus: () => true,
});

const httpOnos = axios.create({
  baseURL: ONOS_API_BASE_URL.replace(/\/+$/, ""),
  timeout: 20000,
  validateStatus: () => true,
});

const httpLenful = axios.create({
  baseURL: "https://s-lencam.lenful.com",
  timeout: 20000,
  validateStatus: () => true,
});

// ====== HELPERS ======
const norm = (s) => String(s || "").trim();
const lower = (s) => norm(s).toLowerCase();

function toMoneyNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function isValidTrackingNumber(s) {
  const t = norm(s);
  if (!t) return false;
  if (/^\[object\s+Object\]$/i.test(t)) return false;
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
  if (s.includes("luxurypro") || s.includes("luxury pro")) return "luxurypro";
  if (s.includes("onos")) return "onos";
  if (s.includes("lenful")) return "lenful";
  if (["beeful", "merchfox", "merchize", "printway", "mangotee", "ss88", "luxurypro", "onos", "lenful"].includes(s))
    return s;
  return "";
}

const TRACKING_VENDOR_KEYS = new Set([
  "beeful",
  "merchfox",
  "merchize",
  "printway",
  "mangotee",
  "ss88",
  "luxurypro",
  "onos",
  "lenful",
]);
const TRACKING_VENDOR_SUBMISSION_KEYS = [
  "grabink",
  "beeful",
  "merchfox",
  "merchize",
  "printway",
  "mangotee",
  "ss88",
  "luxurypro",
  "onos",
  "lenful",
];
const DEFAULT_TRACKING_SENT_WITHIN_DAYS = 30;

function toPlainObject(value) {
  return value?.toObject?.() ? value.toObject() : value;
}

function isOnOrAfter(value, cutoff) {
  if (!cutoff) return true;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) && date >= cutoff;
}

function getTrackingSentAfter({ sentAfter, sentWithinDays } = {}) {
  const rawDate = norm(sentAfter || process.env.PULL_TRACKING_SENT_AFTER);
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }

  const days = Number(sentWithinDays || process.env.PULL_TRACKING_SENT_WITHIN_DAYS || DEFAULT_TRACKING_SENT_WITHIN_DAYS);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function buildSentVendorSubmissionQuery(sentAfter) {
  const sentAtFilter = sentAfter ? { $gte: sentAfter } : { $exists: true };
  return {
    $or: [
      ...TRACKING_VENDOR_SUBMISSION_KEYS.map((key) => ({
        [`vendor_submissions.${key}.sent`]: true,
        [`vendor_submissions.${key}.sent_at`]: sentAtFilter,
      })),
      { "grabink_submission.sent": true, "grabink_submission.sent_at": sentAtFilter },
    ],
  };
}

function getSentTrackingVendorKeys(doc = {}, { sentAfter = null } = {}) {
  const keys = new Set();
  const submissions = toPlainObject(doc.vendor_submissions) || {};

  for (const [rawKey, rawSubmission] of Object.entries(submissions)) {
    const vendorKey = normalizeVendorKey(rawKey);
    const submission = toPlainObject(rawSubmission) || {};
    if (
      TRACKING_VENDOR_KEYS.has(vendorKey) &&
      submission.sent === true &&
      isOnOrAfter(submission.sent_at, sentAfter)
    ) {
      keys.add(vendorKey);
    }
  }

  if (
    doc.grabink_submission?.sent === true &&
    isOnOrAfter(doc.grabink_submission?.sent_at, sentAfter)
  ) {
    keys.add("beeful");
  }

  return [...keys];
}

function getItemVendorKey(doc, item, sentVendorKeys = []) {
  const vpid = item?.cost_breakdown?.vendorProductId;
  const cached = vpid ? doc.__vpidToVendor?.get(String(vpid)) : null;
  const fulfillmentVendorKey = normalizeVendorKey(item?.tracking_info?.fulfillment);
  return sentVendorKeys.length === 1
    ? sentVendorKeys[0]
    : fulfillmentVendorKey || cached?.vendorKey || "";
}

function parseGrabinkActualCost(raw = {}) {
  const itemCost = toMoneyNumber(raw?.cost);
  const shippingFee = toMoneyNumber(raw?.chargeShippingFee);
  if (itemCost === null && shippingFee === null) return null;

  return {
    itemCost: roundMoney(itemCost || 0),
    shippingFee: roundMoney(shippingFee || 0),
    total: roundMoney((itemCost || 0) + (shippingFee || 0)),
    rawItems: Array.isArray(raw?.items) ? raw.items : [],
  };
}

function findGrabinkRawItem(rawItems, item) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const candidates = [
    item?.cost_breakdown?.matchedSku,
    item?.mapped_sku,
    item?.sku,
  ]
    .map((value) => lower(value))
    .filter(Boolean);

  return rawItems.find((rawItem) => candidates.includes(lower(rawItem?.sku))) || null;
}

function applyGrabinkActualCost(doc, raw, targetIndexes = []) {
  const cost = parseGrabinkActualCost(raw);
  if (!cost) return false;

  const previousBaseCost = toMoneyNumber(doc.base_cost) || 0;
  const previousComputedAt = doc.base_cost_computed_at || null;
  const previousGroups = JSON.stringify(doc.base_cost_shipping_groups || []);

  doc.base_cost = cost.total;
  doc.base_cost_computed_at = new Date();
  doc.base_cost_shipping_groups = [
    {
      group_key: `grabink:${norm(raw?.code || doc.orderId)}`,
      total_qty: targetIndexes.reduce((sum, index) => {
        const qty = toMoneyNumber(doc.items?.[index]?.quantity);
        return sum + (qty || 0);
      }, 0),
      shipping_economy_once: cost.shippingFee,
      shipping_additional_rate: 0,
      shipping_additional_units: 0,
      shipping_total_for_group: cost.shippingFee,
    },
  ];

  const shippingPerItem = targetIndexes.length > 0 ? cost.shippingFee / targetIndexes.length : 0;
  for (const index of targetIndexes) {
    const item = doc.items?.[index];
    if (!item) continue;

    const rawItem = findGrabinkRawItem(cost.rawItems, item);
    const quantity = toMoneyNumber(item.quantity) || 1;
    const rawUnitCost = toMoneyNumber(rawItem?.cost);
    const fallbackUnitCost = targetIndexes.length === 1 ? cost.itemCost / quantity : null;
    const unitCost = rawUnitCost !== null ? rawUnitCost : fallbackUnitCost;
    if (unitCost === null) continue;

    item.cost_breakdown = {
      ...(item.cost_breakdown?.toObject?.() ? item.cost_breakdown.toObject() : item.cost_breakdown || {}),
      base_cost_each: roundMoney(unitCost),
      quantity,
      base_cost_total_for_item_including_shipping: roundMoney(unitCost * quantity + shippingPerItem),
    };
  }

  if (typeof doc.markModified === "function") {
    doc.markModified("items");
    doc.markModified("base_cost_shipping_groups");
  }

  return (
    roundMoney(previousBaseCost) !== cost.total ||
    !previousComputedAt ||
    previousGroups !== JSON.stringify(doc.base_cost_shipping_groups || [])
  );
}

function getLenfulToken() {
  return process.env.LENFUL_API_KEY || process.env.LENFUL_ACCESS_TOKEN || process.env.LENFUL_TOKEN || "";
}

function getLenfulDetailRoot(raw = {}) {
  const detail = raw?.detail || raw;
  return detail?.data && typeof detail.data === "object" ? detail.data : detail;
}

function parseLenfulActualCost(raw = {}) {
  const detail = getLenfulDetailRoot(raw);
  const totalPrice = toMoneyNumber(detail?.total_price);
  if (totalPrice === null) return null;

  return {
    total: roundMoney(totalPrice),
    shippingFee: roundMoney(toMoneyNumber(detail?.shipping_method?.price) || 0),
    detail,
    rawItems: Array.isArray(detail?.line_items) ? detail.line_items : [],
    orderId: norm(detail?.id || raw?.tracking?.order_id || raw?.order_id),
  };
}

function findLenfulRawItem(rawItems, item) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const candidates = [
    item?.cost_breakdown?.matchedSku,
    item?.mapped_sku,
    item?.sku,
  ]
    .map((value) => lower(value))
    .filter(Boolean);

  return rawItems.find((rawItem) => candidates.includes(lower(rawItem?.variant?.sku || rawItem?.sku))) || null;
}

function applyLenfulActualCost(doc, raw, targetIndexes = []) {
  const cost = parseLenfulActualCost(raw);
  if (!cost) return false;

  const previousBaseCost = toMoneyNumber(doc.base_cost) || 0;
  const previousComputedAt = doc.base_cost_computed_at || null;
  const previousGroups = JSON.stringify(doc.base_cost_shipping_groups || []);

  doc.base_cost = cost.total;
  doc.base_cost_computed_at = new Date();
  doc.base_cost_shipping_groups = [
    {
      group_key: `lenful:${cost.orderId || norm(doc.orderId)}`,
      total_qty: targetIndexes.reduce((sum, index) => {
        const qty = toMoneyNumber(doc.items?.[index]?.quantity);
        return sum + (qty || 0);
      }, 0),
      shipping_economy_once: cost.shippingFee,
      shipping_additional_rate: 0,
      shipping_additional_units: 0,
      shipping_total_for_group: cost.shippingFee,
    },
  ];

  const shippingPerItem = targetIndexes.length > 0 ? cost.shippingFee / targetIndexes.length : 0;
  for (const index of targetIndexes) {
    const item = doc.items?.[index];
    if (!item) continue;

    const rawItem = findLenfulRawItem(cost.rawItems, item);
    const quantity = toMoneyNumber(item.quantity) || toMoneyNumber(rawItem?.quantity) || 1;
    const lineTotal = toMoneyNumber(rawItem?.total);
    const variantPrice = toMoneyNumber(rawItem?.variant?.price);
    const unitCost = lineTotal !== null ? lineTotal / quantity : variantPrice;
    if (unitCost === null) continue;

    item.cost_breakdown = {
      ...(item.cost_breakdown?.toObject?.() ? item.cost_breakdown.toObject() : item.cost_breakdown || {}),
      base_cost_each: roundMoney(unitCost),
      quantity,
      base_cost_total_for_item_including_shipping: roundMoney(unitCost * quantity + shippingPerItem),
    };
  }

  if (typeof doc.markModified === "function") {
    doc.markModified("items");
    doc.markModified("base_cost_shipping_groups");
  }

  return (
    roundMoney(previousBaseCost) !== cost.total ||
    !previousComputedAt ||
    previousGroups !== JSON.stringify(doc.base_cost_shipping_groups || [])
  );
}

function getMangoTeeDetailRoot(raw = {}) {
  return raw?.data && typeof raw.data === "object" ? raw.data : raw;
}

function parseMangoTeeActualCost(raw = {}) {
  const detail = getMangoTeeDetailRoot(raw);
  const total = toMoneyNumber(detail?.total ?? detail?.Total);
  if (total === null) return null;

  return {
    total: roundMoney(total),
    shippingFee: roundMoney(toMoneyNumber(detail?.shipping_fee ?? detail?.shippingFee) || 0),
    detail,
    rawItems: Array.isArray(detail?.items) ? detail.items : [],
    orderId: norm(detail?.id || detail?.order_id || raw?.id || raw?.order_id),
  };
}

function findMangoTeeRawItem(rawItems, item) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const candidates = [
    item?.cost_breakdown?.matchedSku,
    item?.mapped_sku,
    item?.sku,
  ]
    .map((value) => lower(value))
    .filter(Boolean);

  return rawItems.find((rawItem) => candidates.includes(lower(rawItem?.sku))) || null;
}

function applyMangoTeeActualCost(doc, raw, targetIndexes = []) {
  const cost = parseMangoTeeActualCost(raw);
  if (!cost) return false;

  const previousBaseCost = toMoneyNumber(doc.base_cost) || 0;
  const previousComputedAt = doc.base_cost_computed_at || null;
  const previousGroups = JSON.stringify(doc.base_cost_shipping_groups || []);

  doc.base_cost = cost.total;
  doc.base_cost_computed_at = new Date();
  doc.base_cost_shipping_groups = [
    {
      group_key: `mangotee:${cost.orderId || norm(doc.orderId)}`,
      total_qty: targetIndexes.reduce((sum, index) => {
        const qty = toMoneyNumber(doc.items?.[index]?.quantity);
        return sum + (qty || 0);
      }, 0),
      shipping_economy_once: cost.shippingFee,
      shipping_additional_rate: 0,
      shipping_additional_units: 0,
      shipping_total_for_group: cost.shippingFee,
    },
  ];

  const shippingPerItem = targetIndexes.length > 0 ? cost.shippingFee / targetIndexes.length : 0;
  for (const index of targetIndexes) {
    const item = doc.items?.[index];
    if (!item) continue;

    const rawItem = findMangoTeeRawItem(cost.rawItems, item);
    const quantity = toMoneyNumber(item.quantity) || toMoneyNumber(rawItem?.quantity) || 1;
    const unitCost = toMoneyNumber(rawItem?.base_cost);
    if (unitCost === null) continue;

    item.cost_breakdown = {
      ...(item.cost_breakdown?.toObject?.() ? item.cost_breakdown.toObject() : item.cost_breakdown || {}),
      base_cost_each: roundMoney(unitCost),
      quantity,
      base_cost_total_for_item_including_shipping: roundMoney(unitCost * quantity + shippingPerItem),
    };
  }

  if (typeof doc.markModified === "function") {
    doc.markModified("items");
    doc.markModified("base_cost_shipping_groups");
  }

  return (
    roundMoney(previousBaseCost) !== cost.total ||
    !previousComputedAt ||
    previousGroups !== JSON.stringify(doc.base_cost_shipping_groups || [])
  );
}

function getMerchizeDetailRoot(raw = {}) {
  return raw?.data && typeof raw.data === "object" ? raw.data : raw;
}

function parseMerchizeActualCost(raw = {}) {
  const detail = getMerchizeDetailRoot(raw);
  const total = toMoneyNumber(detail?.fulfillment_cost?.total);
  if (total === null) return null;

  return {
    total: roundMoney(total),
    shippingFee: roundMoney(toMoneyNumber(detail?.fulfillment_cost?.shipping_cost) || 0),
    fulfillmentCost: roundMoney(toMoneyNumber(detail?.fulfillment_cost?.fulfillment_cost) || 0),
    detail,
    rawItems: Array.isArray(detail?.items) ? detail.items : [],
    orderId: norm(detail?._id || detail?.code || detail?.external_number || raw?._id || raw?.code),
  };
}

function findMerchizeRawItem(rawItems, item) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const candidates = [
    item?.cost_breakdown?.matchedSku,
    item?.mapped_sku,
    item?.sku,
  ]
    .map((value) => lower(value))
    .filter(Boolean);

  return rawItems.find((rawItem) => candidates.includes(lower(rawItem?.sku))) || null;
}

function applyMerchizeActualCost(doc, raw, targetIndexes = []) {
  const cost = parseMerchizeActualCost(raw);
  if (!cost) return false;

  const previousBaseCost = toMoneyNumber(doc.base_cost) || 0;
  const previousComputedAt = doc.base_cost_computed_at || null;
  const previousGroups = JSON.stringify(doc.base_cost_shipping_groups || []);

  doc.base_cost = cost.total;
  doc.base_cost_computed_at = new Date();
  doc.base_cost_shipping_groups = [
    {
      group_key: `merchize:${cost.orderId || norm(doc.orderId)}`,
      total_qty: targetIndexes.reduce((sum, index) => {
        const qty = toMoneyNumber(doc.items?.[index]?.quantity);
        return sum + (qty || 0);
      }, 0),
      shipping_economy_once: cost.shippingFee,
      shipping_additional_rate: 0,
      shipping_additional_units: 0,
      shipping_total_for_group: cost.shippingFee,
    },
  ];

  const shippingPerItem = targetIndexes.length > 0 ? cost.shippingFee / targetIndexes.length : 0;
  for (const index of targetIndexes) {
    const item = doc.items?.[index];
    if (!item) continue;

    const rawItem = findMerchizeRawItem(cost.rawItems, item);
    const quantity = toMoneyNumber(item.quantity) || toMoneyNumber(rawItem?.quantity) || 1;
    const rawUnitCost = toMoneyNumber(rawItem?.base_cost);
    const price = toMoneyNumber(rawItem?.price);
    const fallbackUnitCost =
      targetIndexes.length === 1 && cost.fulfillmentCost > 0 ? cost.fulfillmentCost / quantity : null;
    const unitCost = rawUnitCost !== null ? rawUnitCost : price && price > 0 ? price : fallbackUnitCost;
    if (unitCost === null) continue;

    item.cost_breakdown = {
      ...(item.cost_breakdown?.toObject?.() ? item.cost_breakdown.toObject() : item.cost_breakdown || {}),
      base_cost_each: roundMoney(unitCost),
      quantity,
      base_cost_total_for_item_including_shipping: roundMoney(unitCost * quantity + shippingPerItem),
    };
  }

  if (typeof doc.markModified === "function") {
    doc.markModified("items");
    doc.markModified("base_cost_shipping_groups");
  }

  return (
    roundMoney(previousBaseCost) !== cost.total ||
    !previousComputedAt ||
    previousGroups !== JSON.stringify(doc.base_cost_shipping_groups || [])
  );
}

function parseMerchFoxActualCost(raw = {}) {
  const total = toMoneyNumber(raw?.total);
  if (total === null) return null;

  return {
    total: roundMoney(total),
    shippingFee: 0,
    rawItems: Array.isArray(raw?.products) ? raw.products : [],
    orderId: norm(raw?.mfid || raw?.mfif || raw?.orderid),
  };
}

function findMerchFoxRawItem(rawItems, item) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const candidates = [
    item?.cost_breakdown?.matchedSku,
    item?.mapped_sku,
    item?.sku,
  ]
    .map((value) => lower(value))
    .filter(Boolean);

  return rawItems.find((rawItem) => candidates.includes(lower(rawItem?.sku?.sku || rawItem?.sku))) || null;
}

function applyMerchFoxActualCost(doc, raw, targetIndexes = []) {
  const cost = parseMerchFoxActualCost(raw);
  if (!cost) return false;

  const previousBaseCost = toMoneyNumber(doc.base_cost) || 0;
  const previousComputedAt = doc.base_cost_computed_at || null;
  const previousGroups = JSON.stringify(doc.base_cost_shipping_groups || []);

  doc.base_cost = cost.total;
  doc.base_cost_computed_at = new Date();
  doc.base_cost_shipping_groups = [
    {
      group_key: `merchfox:${cost.orderId || norm(doc.orderId)}`,
      total_qty: targetIndexes.reduce((sum, index) => {
        const qty = toMoneyNumber(doc.items?.[index]?.quantity);
        return sum + (qty || 0);
      }, 0),
      shipping_economy_once: cost.shippingFee,
      shipping_additional_rate: 0,
      shipping_additional_units: 0,
      shipping_total_for_group: cost.shippingFee,
    },
  ];

  const shippingPerItem = targetIndexes.length > 0 ? cost.shippingFee / targetIndexes.length : 0;
  for (const index of targetIndexes) {
    const item = doc.items?.[index];
    if (!item) continue;

    const rawItem = findMerchFoxRawItem(cost.rawItems, item);
    const quantity = toMoneyNumber(item.quantity) || toMoneyNumber(rawItem?.quantity) || 1;
    const unitCost = toMoneyNumber(rawItem?.price);
    if (unitCost === null) continue;

    item.cost_breakdown = {
      ...(item.cost_breakdown?.toObject?.() ? item.cost_breakdown.toObject() : item.cost_breakdown || {}),
      base_cost_each: roundMoney(unitCost),
      quantity,
      base_cost_total_for_item_including_shipping: roundMoney(unitCost * quantity + shippingPerItem),
    };
  }

  if (typeof doc.markModified === "function") {
    doc.markModified("items");
    doc.markModified("base_cost_shipping_groups");
  }

  return (
    roundMoney(previousBaseCost) !== cost.total ||
    !previousComputedAt ||
    previousGroups !== JSON.stringify(doc.base_cost_shipping_groups || [])
  );
}

function parsePrintwayActualCost(raw = {}) {
  const total = toMoneyNumber(raw?.total_price);
  if (total === null) return null;

  return {
    total: roundMoney(total),
    shippingFee: roundMoney(toMoneyNumber(raw?.shipping_fee) || 0),
    rawItems: Array.isArray(raw?.orderitems) ? raw.orderitems : [],
    orderId: norm(raw?.pw_order_id || raw?.order_name),
  };
}

function findPrintwayRawItem(rawItems, item) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const candidates = [
    item?.cost_breakdown?.matchedSku,
    item?.mapped_sku,
    item?.sku,
  ]
    .map((value) => lower(value))
    .filter(Boolean);

  return rawItems.find((rawItem) => candidates.includes(lower(rawItem?.item_sku || rawItem?.sku))) || null;
}

function applyPrintwayActualCost(doc, raw, targetIndexes = []) {
  const cost = parsePrintwayActualCost(raw);
  if (!cost) return false;

  const previousBaseCost = toMoneyNumber(doc.base_cost) || 0;
  const previousComputedAt = doc.base_cost_computed_at || null;
  const previousGroups = JSON.stringify(doc.base_cost_shipping_groups || []);

  doc.base_cost = cost.total;
  doc.base_cost_computed_at = new Date();
  doc.base_cost_shipping_groups = [
    {
      group_key: `printway:${cost.orderId || norm(doc.orderId)}`,
      total_qty: targetIndexes.reduce((sum, index) => {
        const qty = toMoneyNumber(doc.items?.[index]?.quantity);
        return sum + (qty || 0);
      }, 0),
      shipping_economy_once: cost.shippingFee,
      shipping_additional_rate: 0,
      shipping_additional_units: 0,
      shipping_total_for_group: cost.shippingFee,
    },
  ];

  const shippingPerItem = targetIndexes.length > 0 ? cost.shippingFee / targetIndexes.length : 0;
  for (const index of targetIndexes) {
    const item = doc.items?.[index];
    if (!item) continue;

    const rawItem = findPrintwayRawItem(cost.rawItems, item);
    const quantity = toMoneyNumber(item.quantity) || toMoneyNumber(rawItem?.quantity) || 1;
    const unitCost = toMoneyNumber(rawItem?.base_cost);
    const itemTotal = toMoneyNumber(rawItem?.item_price);
    if (unitCost === null) continue;

    item.cost_breakdown = {
      ...(item.cost_breakdown?.toObject?.() ? item.cost_breakdown.toObject() : item.cost_breakdown || {}),
      base_cost_each: roundMoney(unitCost),
      quantity,
      base_cost_total_for_item_including_shipping: roundMoney(itemTotal !== null ? itemTotal : unitCost * quantity + shippingPerItem),
    };
  }

  if (typeof doc.markModified === "function") {
    doc.markModified("items");
    doc.markModified("base_cost_shipping_groups");
  }

  return (
    roundMoney(previousBaseCost) !== cost.total ||
    !previousComputedAt ||
    previousGroups !== JSON.stringify(doc.base_cost_shipping_groups || [])
  );
}

function getOnosDetailRoot(raw = {}) {
  const detail = raw?.detail && typeof raw.detail === "object" ? raw.detail : raw;
  return detail?.data && typeof detail.data === "object" ? detail.data : detail;
}

function parseOnosActualCost(raw = {}) {
  const detail = getOnosDetailRoot(raw);
  const total = toMoneyNumber(detail?.total);
  if (total === null) return null;

  return {
    total: roundMoney(total),
    shippingFee: roundMoney(toMoneyNumber(detail?.base_ship_total ?? detail?.ship_cost) || 0),
    baseCost: roundMoney(toMoneyNumber(detail?.base_cost ?? detail?.fulfillment_cost ?? detail?.base_total) || 0),
    rawItems: Array.isArray(detail?.items) ? detail.items : [],
    orderId: norm(detail?.id || detail?.order_id),
  };
}

function findOnosRawItem(rawItems, item) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const candidates = [
    item?.cost_breakdown?.matchedSku,
    item?.mapped_sku,
    item?.sku,
  ]
    .map((value) => lower(value))
    .filter(Boolean);

  return rawItems.find((rawItem) => candidates.includes(lower(rawItem?.sku || rawItem?.product_id))) || null;
}

function applyOnosActualCost(doc, raw, targetIndexes = []) {
  const cost = parseOnosActualCost(raw);
  if (!cost) return false;

  const previousBaseCost = toMoneyNumber(doc.base_cost) || 0;
  const previousComputedAt = doc.base_cost_computed_at || null;
  const previousGroups = JSON.stringify(doc.base_cost_shipping_groups || []);

  doc.base_cost = cost.total;
  doc.base_cost_computed_at = new Date();
  doc.base_cost_shipping_groups = [
    {
      group_key: `onos:${cost.orderId || norm(doc.orderId)}`,
      total_qty: targetIndexes.reduce((sum, index) => {
        const qty = toMoneyNumber(doc.items?.[index]?.quantity);
        return sum + (qty || 0);
      }, 0),
      shipping_economy_once: cost.shippingFee,
      shipping_additional_rate: 0,
      shipping_additional_units: 0,
      shipping_total_for_group: cost.shippingFee,
    },
  ];

  const shippingPerItem = targetIndexes.length > 0 ? cost.shippingFee / targetIndexes.length : 0;
  const totalTargetQuantity = targetIndexes.reduce((sum, index) => {
    const qty = toMoneyNumber(doc.items?.[index]?.quantity);
    return sum + (qty || 0);
  }, 0);

  for (const index of targetIndexes) {
    const item = doc.items?.[index];
    if (!item) continue;

    const rawItem = findOnosRawItem(cost.rawItems, item);
    const quantity = toMoneyNumber(item.quantity) || toMoneyNumber(rawItem?.quantity) || 1;
    const unitCost =
      toMoneyNumber(rawItem?.base_cost) ??
      (cost.baseCost > 0 && totalTargetQuantity > 0 ? cost.baseCost / totalTargetQuantity : null);
    if (unitCost === null) continue;

    const itemTotal =
      targetIndexes.length === 1
        ? cost.total
        : roundMoney(unitCost * quantity + shippingPerItem);

    item.cost_breakdown = {
      ...(item.cost_breakdown?.toObject?.() ? item.cost_breakdown.toObject() : item.cost_breakdown || {}),
      base_cost_each: roundMoney(unitCost),
      quantity,
      base_cost_total_for_item_including_shipping: roundMoney(itemTotal),
    };
  }

  if (typeof doc.markModified === "function") {
    doc.markModified("items");
    doc.markModified("base_cost_shipping_groups");
  }

  return (
    roundMoney(previousBaseCost) !== cost.total ||
    !previousComputedAt ||
    previousGroups !== JSON.stringify(doc.base_cost_shipping_groups || [])
  );
}

const isObjectIdLike = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || "").trim());
const isForceTrue = (value) => value === true || String(value).toLowerCase() === "true";

function getMaxEtsyTrackingBatchItems() {
  const n = Number(process.env.ETSY_TRACKING_BATCH_MAX || 100);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function normalizeEtsyUploadTrackingBody(body = {}) {
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const machineId = norm(
    body.machineId ||
    payload.machineId ||
    body.mongoShopId ||
    payload.mongoShopId ||
    body.shopId ||
    payload.shopId
  );
  const shopId = norm(body.shopId || payload.shopId || machineId);
  const mongoShopId = norm(body.mongoShopId || payload.mongoShopId || machineId);
  const orderId = norm(payload.orderId || body.orderId);
  const trackingNumber = norm(payload.trackingNumber || body.trackingNumber);
  const force = isForceTrue(body.force) || isForceTrue(payload.force);

  if (!machineId) return { ok: false, message: "machineId is required" };
  if (!shopId) return { ok: false, message: "shopId is required" };
  if (!mongoShopId) return { ok: false, message: "mongoShopId is required" };
  if (!isObjectIdLike(machineId)) return { ok: false, message: "machineId must be a valid ObjectId" };
  if (!isObjectIdLike(shopId)) return { ok: false, message: "shopId must be a valid ObjectId" };
  if (!isObjectIdLike(mongoShopId)) return { ok: false, message: "mongoShopId must be a valid ObjectId" };
  if (new Set([machineId, shopId, mongoShopId].filter(Boolean)).size > 1) {
    return { ok: false, message: "shopId, machineId, and mongoShopId must match for Etsy upload tracking" };
  }
  if (!orderId) return { ok: false, message: "orderId is required" };
  if (!trackingNumber) return { ok: false, message: "trackingNumber is required" };

  return {
    ok: true,
    body: {
      ...body,
      shopId,
      machineId,
      force,
      type: "ETSY_UPLOAD_TRACKING",
      payload: {
        ...payload,
        machineId,
        mongoShopId,
        shopId,
        orderId,
        trackingNumber,
        ...(force ? { force: true } : {}),
      },
    },
  };
}

function normalizeEtsyUploadTrackingBatchBody(body = {}) {
  const machineId = norm(body.machineId || body.mongoShopId || body.shopId);
  const shopId = norm(body.shopId || machineId);
  const mongoShopId = norm(body.mongoShopId || machineId);
  const force = isForceTrue(body.force);

  if (!machineId) return { ok: false, message: "machineId is required" };
  if (!shopId) return { ok: false, message: "shopId is required" };
  if (!mongoShopId) return { ok: false, message: "mongoShopId is required" };
  if (!isObjectIdLike(machineId)) return { ok: false, message: "machineId must be a valid ObjectId" };
  if (!isObjectIdLike(shopId)) return { ok: false, message: "shopId must be a valid ObjectId" };
  if (!isObjectIdLike(mongoShopId)) return { ok: false, message: "mongoShopId must be a valid ObjectId" };
  if (new Set([machineId, shopId, mongoShopId].filter(Boolean)).size > 1) {
    return { ok: false, message: "shopId, machineId, and mongoShopId must match for Etsy upload tracking" };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, message: "items must be a non-empty array" };
  }
  const maxItems = getMaxEtsyTrackingBatchItems();
  if (body.items.length > maxItems) {
    return { ok: false, message: `items exceeds max batch size ${maxItems}` };
  }

  return {
    ok: true,
    body: {
      machineId,
      shopId,
      mongoShopId,
      force,
      items: body.items,
    },
  };
}

async function getEtsyTrackingDuplicateSkip({ taskId, force }) {
  if (isForceTrue(force)) return null;
  if (!ExtensionTask || typeof ExtensionTask.findOne !== "function") return null;

  const existing = await ExtensionTask.findOne({ taskId }).lean();
  if (["sent", "received"].includes(existing?.status)) {
    return {
      ok: true,
      skipped: true,
      reason: "TASK_ALREADY_RUNNING",
      status: existing.status,
      taskId,
      message: "Etsy upload tracking task is already pending/running",
    };
  }
  if (existing?.status === "completed") {
    return {
      ok: true,
      skipped: true,
      reason: "TASK_ALREADY_COMPLETED",
      status: existing.status,
      taskId,
      message: "Etsy upload tracking task already completed",
    };
  }

  return null;
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

function getVendorFulfillmentName(vendorKey) {
  return (
    {
      beeful: "Beeful",
      merchfox: "MerchFox",
      merchize: "Merchize",
      printway: "Printway",
      mangotee: "MangoTee",
      ss88: "SS88",
      luxurypro: "LuxuryPro",
      onos: "Onos",
      lenful: "Lenful",
    }[vendorKey] || ""
  );
}

function isNonCriticalTrackingPullError(err) {
  const message = lower(err?.message);
  return (
    message.includes(" empty") ||
    message.includes("empty ") ||
    message.includes("not found") ||
    message.includes("not_found") ||
    message.includes("no data")
  );
}

async function fetchTrackingByVendorKey(vendorKey, orderId, doc) {
  if (vendorKey === "beeful") return fetchBeeful(orderId);
  if (vendorKey === "merchfox") return fetchMerchFox(orderId);
  if (vendorKey === "merchize") return fetchMerchize(orderId);
  if (vendorKey === "printway") return fetchPrintway(orderId, doc);
  if (vendorKey === "mangotee") return fetchMangoTee(orderId);
  if (vendorKey === "ss88") return fetchSS88(orderId);
  if (vendorKey === "luxurypro") return fetchLuxuryPro(orderId);
  if (vendorKey === "onos") return fetchOnos(orderId, doc);
  if (vendorKey === "lenful") return fetchLenful(orderId, doc);
  throw new Error(`Unsupported vendor: ${vendorKey}`);
}

// ====== VENDOR FETCHERS ======
async function fetchBeeful(orderId) {
  const url = `/api/external/order/${encodeURIComponent(orderId)}`;
  const res = await httpBeeful.get(url, {
    params: { api_key: GRABINK_API_KEY },
  });
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
  if (res.status >= 400)
    throw new Error(`Merchize HTTP ${res.status} (tracking)`);

  let trackingResult = null;
  if (res.data?.success === true) {
    const obj = Array.isArray(res.data.data) ? res.data.data[0] : res.data.data;
    if (obj && typeof obj === "object") {
      const tracking = norm(obj?.tracking_number);
      const carrier = norm(obj?.tracking_company);
      const shipped = isValidTrackingNumber(tracking);

      trackingResult = { tracking, carrier, shipped, raw: obj };
    }
  }

  // 2) Fallback: order-detail
  res = await httpMerchize.get("/order/external/orders/order-detail", {
    params: { external_number: orderId },
  });
  if (res.status >= 400)
    throw new Error(`Merchize HTTP ${res.status} (detail)`);

  if (res.data?.success === true) {
    const obj = Array.isArray(res.data.data) ? res.data.data[0] : res.data.data;
    if (!obj || typeof obj !== "object") {
      throw new Error(`Merchize empty for ${orderId}`);
    }
    const tracking = norm(obj?.tracking_number);
    const carrier = norm(obj?.tracking_company);
    const pickedTracking = trackingResult?.tracking || tracking;
    const pickedCarrier = trackingResult?.carrier || carrier;
    const shipped = Boolean(trackingResult?.shipped) || isValidTrackingNumber(pickedTracking);

    return {
      tracking: pickedTracking,
      carrier: pickedCarrier,
      shipped,
      raw: {
        ...obj,
        tracking_response: trackingResult?.raw || null,
      },
    };
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

function getOnosExternalOrderId(orderId, doc = {}) {
  return (
    norm(doc?.vendor_submissions?.onos?.external_id) ||
    norm(doc?.external_order_id) ||
    norm(orderId)
  );
}

function pickOnosTracking(raw) {
  const normalized = normalizeVendorTrackingPayload("onos", raw);
  const root = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  return {
    tracking: normalized.trackingNumber,
    carrier: normalized.carrier,
    shipped: normalized.shipped,
    raw: root || raw,
  };
}

async function fetchOnos(orderId, doc) {
  const apiKey = ONOS_API_KEY || ONOS_ACCESS_TOKEN;
  if (!apiKey) throw new Error("Onos missing API key (ONOS_API_KEY)");

  const onosOrderId = getOnosExternalOrderId(orderId, doc);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const detailRes = await httpOnos.get(`/order/${encodeURIComponent(onosOrderId)}`, { headers });
  if (detailRes.status >= 400) {
    throw new Error(`Onos HTTP ${detailRes.status}: ${detailRes.data?.message || detailRes.data?.error || "order detail failed"}`);
  }
  if (!detailRes.data || typeof detailRes.data !== "object") throw new Error("Onos empty order detail payload");
  if (detailRes.data.status === false || detailRes.data.error) {
    throw new Error(`Onos bad order detail response: ${detailRes.data.message || detailRes.data.error || "status=false"}`);
  }

  const eventsRes = await httpOnos.get(`/order/${encodeURIComponent(onosOrderId)}/shipment/events`, { headers });
  if (eventsRes.status >= 400 && DEBUG) {
    console.warn(`[Onos][shipment/events] HTTP ${eventsRes.status} for ${onosOrderId}`);
  }

  const raw = {
    detail: detailRes.data,
    shipment_events:
      eventsRes.status < 400 && eventsRes.data && typeof eventsRes.data === "object"
        ? eventsRes.data
        : null,
  };

  const events = Array.isArray(eventsRes.data?.data)
    ? eventsRes.data.data
    : Array.isArray(eventsRes.data?.events)
      ? eventsRes.data.events
      : [];
  const detailData =
    detailRes.data?.data && typeof detailRes.data.data === "object"
      ? detailRes.data.data
      : detailRes.data;
  const picked = pickOnosTracking({ data: { ...detailData, events } });

  return { ...picked, raw };
}

function getLenfulExternalOrderId(doc = {}) {
  return norm(doc?.vendor_submissions?.lenful?.external_id);
}

function getLenfulDetailOrderId(doc = {}) {
  return norm(
    doc?.vendor_submissions?.lenful?.tracking_last_response?.order_id ||
    doc?.vendor_submissions?.lenful?.order_id
  );
}

function pickLenfulTracking(raw, orderId, doc = {}) {
  const rows = Array.isArray(raw?.data) ? raw.data : [];
  const trimmedOrderId = norm(orderId);
  const externalId = getLenfulExternalOrderId(doc);
  const picked =
    rows.find((row) => norm(row?.order_number) === trimmedOrderId) ||
    rows.find((row) => externalId && norm(row?.order_short_id) === externalId);

  if (!picked) {
    throw new Error(`Lenful tracking not found for ${trimmedOrderId}`);
  }

  const tracking = norm(picked.number);
  const carrier = norm(picked.company) || norm(picked.translation?.name);
  return { tracking, carrier, shipped: Boolean(tracking), raw: picked };
}

async function fetchLenful(orderId, doc) {
  const token = getLenfulToken();
  if (!token) throw new Error("Lenful missing API key (LENFUL_API_KEY)");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  const res = await httpLenful.get("/api/order/trackings", {
    params: {
      page: 1,
      limit: 50,
      keyword: orderId,
      keyword_type: "order",
      sort_by: "create_at_desc",
    },
    headers,
  });

  if (res.status === 401) {
    throw new Error("Lenful unauthorized (401): check LENFUL_API_KEY");
  }
  if (res.status >= 400) {
    throw new Error(`Lenful HTTP ${res.status}: ${res.data?.message || res.data?.error || "tracking failed"}`);
  }

  const picked = pickLenfulTracking(res.data, orderId, doc);
  const detailOrderId = norm(picked?.raw?.order_id) || getLenfulDetailOrderId(doc);
  if (!detailOrderId) return picked;

  const detailRes = await httpLenful.get(`/api/order/${encodeURIComponent(detailOrderId)}`, {
    headers,
  });
  if (detailRes.status === 401) {
    throw new Error("Lenful unauthorized (401): check LENFUL_API_KEY");
  }
  if (detailRes.status >= 400) {
    throw new Error(`Lenful HTTP ${detailRes.status}: ${detailRes.data?.message || detailRes.data?.error || "order detail failed"}`);
  }

  return {
    ...picked,
    raw: {
      tracking: picked.raw,
      detail: detailRes.data,
      order_id: detailOrderId,
      status: picked.raw?.status,
    },
  };
}

function buildLuxuryProTrackingUrl(orderId) {
  const configured =
    LUXURYPRO_TRACKING_ENDPOINT ||
    LUXURYPRO_DETAIL_ENDPOINT ||
    (LUXURYPRO_ENDPOINT
      ? LUXURYPRO_ENDPOINT.replace(/\/create\/?$/i, "/orders/{orderId}")
      : "https://api.lenauto.com/api/luxurypro/orders/{orderId}");

  if (configured.includes("{orderId}")) {
    return configured.replace("{orderId}", encodeURIComponent(orderId));
  }
  return `${configured.replace(/\/+$/, "")}/${encodeURIComponent(orderId)}`;
}

function pickLuxuryProTracking(raw) {
  const root = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  const candidates = [];

  const push = (obj = {}) => {
    if (!obj || typeof obj !== "object") return;
    const tracking = norm(
      obj.tracking_number ||
      obj.trackingNumber ||
      obj.tracking ||
      obj.tracking_code ||
      obj.trackingCode ||
      obj.tracking_id ||
      obj.trackingId
    );
    const carrier = norm(
      obj.carrier ||
      obj.carrier_name ||
      obj.carrierName ||
      obj.shipping_carrier ||
      obj.shippingCarrier ||
      obj.shipping_provider ||
      obj.shippingProvider
    );
    const status = norm(obj.status || obj.production_status || obj.fulfillment_status);
    const updatedAtMs = new Date(obj.updated_at || obj.updatedAt || obj.shipped_at || obj.shippedAt || 0).getTime();
    if (tracking || carrier || status) candidates.push({ tracking, carrier, status, updatedAtMs });
  };

  push(root);
  push(root?.tracking);
  push(root?.shipment);
  push(root?.shipping);

  for (const key of ["trackings", "tracking_list", "shipments", "fulfillments", "events", "items", "line_items"]) {
    const arr = root?.[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      push(entry);
      push(entry?.tracking);
      push(entry?.shipment);
    }
  }

  const picked = candidates
    .filter((c) => isValidTrackingNumber(c.tracking) || c.carrier || c.status)
    .sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))[0] || {};

  const tracking = isValidTrackingNumber(picked.tracking) ? picked.tracking : "";
  const carrier = picked.carrier || "";
  const status = lower(picked.status || root?.status || root?.production_status || root?.fulfillment_status);
  const shipped = ["shipped", "delivered", "fulfilled", "completed", "complete"].includes(status) || Boolean(tracking);

  return { tracking, carrier, shipped, raw: root || raw };
}

async function fetchLuxuryPro(orderId) {
  const apiKey = LUXURYPRO_API_KEY || LUXURYPRO_ACCESS_TOKEN;
  if (!apiKey) throw new Error("LuxuryPro missing API key (LUXURYPRO_API_KEY)");

  const headers = { Accept: "application/json" };
  if (lower(LUXURYPRO_AUTH_MODE) === "x-api-key") {
    headers["X-API-Key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const url = buildLuxuryProTrackingUrl(orderId);
  const res = await httpLuxuryPro.get(url, { headers });

  if (res.status >= 400) {
    throw new Error(`LuxuryPro HTTP ${res.status}: ${res.data?.message || res.data?.error || "Error"}`);
  }
  if (!res.data || typeof res.data !== "object") throw new Error("LuxuryPro empty payload");
  if (res.data.success === false) {
    throw new Error(`LuxuryPro bad response: ${res.data.message || res.data.error || "success=false"}`);
  }

  return pickLuxuryProTracking(res.data);
}

// ====== APPLY RESULT INTO ORDER DOC ======
function applyToItemsOfVendor(
  doc,
  vendorKey,
  { tracking, carrier, shipped, raw }
) {
  let changed = 0;
  const sentVendorKeys = doc.__sentTrackingVendorKeys || [];
  const targetIndexes = [];

  doc.items = (doc.items || []).map((it, index) => {
    const thisVendorKey = getItemVendorKey(doc, it, sentVendorKeys);

    if (thisVendorKey !== vendorKey) {
      return it.toObject?.() ? it.toObject() : it;
    }
    targetIndexes.push(index);

    const ti = it.tracking_info || {};
    const prevTracking = norm(ti.tracking);
    const thePrevStatus = norm(ti.status);
    const nextTracking = tracking || prevTracking;
    const trackingReceivedAt = resolveTrackingReceivedAt(ti.trackingReceivedAt, prevTracking, nextTracking);

    const nextTI = {
      ...ti,
      fulfillment: getVendorFulfillmentName(vendorKey) || norm(ti.fulfillment),
      tracking: nextTracking,
      carrier: norm(carrier) || norm(ti.carrier),
      ...(trackingReceivedAt ? { trackingReceivedAt } : {}),
      status: shipped ? "Shipped" : thePrevStatus || "New",
      updated_at: new Date(),
      note: buildTrackingNote(ti.note, carrier),
    };

    if (
      nextTI.tracking !== prevTracking ||
      nextTI.carrier !== norm(ti.carrier) ||
      String(nextTI.trackingReceivedAt || "") !== String(ti.trackingReceivedAt || "") ||
      nextTI.status !== thePrevStatus ||
      nextTI.fulfillment !== ti.fulfillment ||
      nextTI.note !== ti.note
    ) {
      changed++;
    }

    return { ...(it.toObject?.() ? it.toObject() : it), tracking_info: nextTI };
  });

  if (vendorKey === "beeful" && applyGrabinkActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "lenful" && applyLenfulActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "mangotee" && applyMangoTeeActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "merchize" && applyMerchizeActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "merchfox" && applyMerchFoxActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "printway" && applyPrintwayActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "onos" && applyOnosActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }

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
  } else if (vendorKey === "luxurypro") {
    doc.luxurypro_submission = {
      ...(doc.luxurypro_submission || {}),
      attempt_count: (doc.luxurypro_submission?.attempt_count || 0) + 1,
      last_response: raw,
      lp_status: norm(raw?.status || raw?.production_status || raw?.fulfillment_status),
    };
  } else if (vendorKey === "onos") {
    doc.vendor_submissions = doc.vendor_submissions || {};
    doc.vendor_submissions.onos = {
      ...(doc.vendor_submissions.onos || {}),
      tracking_attempt_count: (doc.vendor_submissions.onos?.tracking_attempt_count || 0) + 1,
      tracking_last_response: raw,
      tracking_status: norm(raw?.detail?.data?.status || raw?.detail?.status || ""),
    };
    if (typeof doc.markModified === "function") doc.markModified("vendor_submissions");
  } else if (vendorKey === "lenful") {
    doc.vendor_submissions = doc.vendor_submissions || {};
    doc.vendor_submissions.lenful = {
      ...(doc.vendor_submissions.lenful || {}),
      tracking_attempt_count: (doc.vendor_submissions.lenful?.tracking_attempt_count || 0) + 1,
      tracking_last_response: raw,
      tracking_status: norm(raw?.tracking?.status || raw?.status || ""),
    };
    if (typeof doc.markModified === "function") doc.markModified("vendor_submissions");
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

  const vendorKeys = getSentTrackingVendorKeys(doc);
  doc.__sentTrackingVendorKeys = vendorKeys;

  if (vendorKeys.length === 0) {
    throw new Error(
      `No sent vendor submission found for tracking pull: ${orderId}`
    );
  }

  let totalChanged = 0;
  for (const vk of vendorKeys) {
    try {
      const res = await fetchTrackingByVendorKey(vk, orderId, doc);

      totalChanged += applyToItemsOfVendor(doc, vk, res);
    } catch (e) {
      if (!isNonCriticalTrackingPullError(e)) {
        await logOrderLifecycleEvent(buildOrderLifecyclePayload({
          order: doc,
          fallbackPlatform: "amazon",
          actorType: "system",
          stage: "TRACKING_PULL",
          eventType: "TRACKING_PULL_FAILED",
          status: "failed",
          reason: e.message,
          metadata: { provider: vk },
        }));
      }
      if (vk === "lenful") throw e;
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

  if (totalChanged > 0 || orderStatusChanged || doc.__trackingPullCostChanged) {
    await doc.save();
    await logOrderLifecycleEvent(buildOrderLifecyclePayload({
      order: doc,
      fallbackPlatform: "amazon",
      actorType: "system",
      stage: "TRACKING_PULL",
      eventType: "TRACKING_UPDATED",
      status: "success",
      metadata: {
        updatedItems: totalChanged,
        orderStatusChanged,
        costChanged: !!doc.__trackingPullCostChanged,
      },
    }));
  }
  return { updatedItems: totalChanged, orderStatusChanged };
}

async function previewOrderVendorTracking(orderId) {
  const doc = await OrderCustomProduct.findOne({ orderId: String(orderId || "").trim() }).lean();
  if (!doc) throw new Error("Order not found in DB");

  const vpidSet = new Set((doc.items || []).map((item) => item?.cost_breakdown?.vendorProductId).filter(Boolean).map(String));
  doc.__vpidToVendor = await buildVendorMapsFromVpidSet(vpidSet);
  const vendorKeys = getSentTrackingVendorKeys(doc);
  if (!vendorKeys.length) throw new Error("No sent vendor submission found for tracking preview");

  const vendors = [];
  for (const vendorKey of vendorKeys) {
    try {
      const result = await fetchTrackingByVendorKey(vendorKey, doc.orderId, doc);
      const raw = result?.raw && typeof result.raw === "object" ? result.raw : {};
      vendors.push({
        vendorKey,
        normalized: {
          hasTracking: Boolean(norm(result?.tracking)),
          hasCarrier: Boolean(norm(result?.carrier)),
          shipped: Boolean(result?.shipped),
        },
        rawFields: Object.keys(raw).sort(),
      });
    } catch (error) {
      const status = String(error?.message || "").match(/\b([45]\d\d)\b/)?.[1];
      vendors.push({ vendorKey, error: status ? `Vendor request failed (HTTP ${status})` : "Vendor request failed" });
    }
  }
  return { orderId: doc.orderId, vendors };
}

async function runBatch({ max = 1100, dryRun = false, sentAfter = null, sentWithinDays = null } = {}) {
  const trackingSentAfter = getTrackingSentAfter({ sentAfter, sentWithinDays });
  const candidates = await OrderCustomProduct.find({
    status: "Fulfilled",
    ...buildSentVendorSubmissionQuery(trackingSentAfter),
  })
    .sort({ createdAt: -1 })
    .limit(max)
    .lean();

  const vpidSet = new Set();
  for (const o of candidates) {
    for (const it of o.items || []) {
      const vpid = it?.cost_breakdown?.vendorProductId;
      if (vpid) vpidSet.add(String(vpid));
    }
  }

  const vpidToVendor = await buildVendorMapsFromVpidSet(vpidSet);

  const filtered = candidates.filter((o) => {
    return getSentTrackingVendorKeys(o, { sentAfter: trackingSentAfter }).length > 0;
  });

  if (dryRun) {
    return {
      ok: true,
      mode: "dry-run",
      scanned: filtered.length,
      orderIds: filtered.map((o) => o.orderId),
      sentAfter: trackingSentAfter.toISOString(),
      vendorsPerOrder: filtered.map((o) => {
        return {
          orderId: o.orderId,
          vendorKeys: getSentTrackingVendorKeys(o, { sentAfter: trackingSentAfter }),
        };
      }),
    };
  }

  let ok = 0, fail = 0;
  for (const o of filtered) {
    try {
      await updateOrderByVendors(o.orderId, vpidToVendor);
      ok++;
    } catch (err) {
      fail++;
    }
  }

  return { ok, fail, scanned: filtered.length };
}

function buildTrackingNote(prevNote, carrier) {
  const normalizedCarrier = norm(carrier);
  if (!normalizedCarrier) return norm(prevNote);

  const carrierNote = `carrier:${normalizedCarrier}`;
  const parts = norm(prevNote)
    .split("|")
    .map((part) => norm(part))
    .filter(Boolean);

  if (!parts.includes(carrierNote)) parts.push(carrierNote);
  return parts.join(" | ");
}

function applyToEtsyItemsOfVendor(doc, vendorKey, { tracking, carrier, shipped, raw }) {
  let changed = 0;
  const fulfillment = getVendorFulfillmentName(vendorKey);
  const sentVendorKeys = doc.__sentTrackingVendorKeys || [];
  const targetIndexes = [];

  doc.items = (doc.items || []).map((it, index) => {
    const thisVendorKey = getItemVendorKey(doc, it, sentVendorKeys);

    if (thisVendorKey !== vendorKey) {
      return it.toObject?.() ? it.toObject() : it;
    }
    targetIndexes.push(index);

    const ti = it.tracking_info || {};
    const prevTracking = norm(ti.tracking);
    const prevStatus = norm(ti.status);
    const nextTracking = tracking || prevTracking;
    const trackingReceivedAt = resolveTrackingReceivedAt(ti.trackingReceivedAt, prevTracking, nextTracking);
    const nextTI = {
      ...ti,
      fulfillment: fulfillment || norm(ti.fulfillment),
      tracking: nextTracking,
      carrier: norm(carrier) || norm(ti.carrier),
      ...(trackingReceivedAt ? { trackingReceivedAt } : {}),
      status: shipped ? "Shipped" : prevStatus || "New",
      updated_at: new Date(),
      note: buildTrackingNote(ti.note, carrier),
    };

    if (
      nextTI.tracking !== prevTracking ||
      nextTI.carrier !== norm(ti.carrier) ||
      String(nextTI.trackingReceivedAt || "") !== String(ti.trackingReceivedAt || "") ||
      nextTI.status !== prevStatus ||
      nextTI.fulfillment !== ti.fulfillment ||
      nextTI.note !== ti.note
    ) {
      changed++;
    }

    return { ...(it.toObject?.() ? it.toObject() : it), tracking_info: nextTI };
  });

  if (vendorKey === "beeful" && applyGrabinkActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "lenful" && applyLenfulActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "mangotee" && applyMangoTeeActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "merchize" && applyMerchizeActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "merchfox" && applyMerchFoxActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "printway" && applyPrintwayActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }
  if (vendorKey === "onos" && applyOnosActualCost(doc, raw, targetIndexes)) {
    doc.__trackingPullCostChanged = true;
  }

  if (vendorKey === "onos" && changed > 0) {
    doc.vendor_submissions = doc.vendor_submissions || {};
    doc.vendor_submissions.onos = {
      ...(doc.vendor_submissions.onos || {}),
      tracking_attempt_count: (doc.vendor_submissions.onos?.tracking_attempt_count || 0) + 1,
      tracking_last_response: raw,
      tracking_status: norm(raw?.detail?.data?.status || raw?.detail?.status || ""),
    };
    if (typeof doc.markModified === "function") doc.markModified("vendor_submissions");
  }

  return changed;
}

async function updateEtsyOrderByVendors(orderId, options = {}) {
  const trimmedOrderId = norm(orderId);
  const query = { orderId: trimmedOrderId };
  if (options.shopId) query.shopId = options.shopId;

  const doc = await EtsyOrder.findOne(query);
  if (!doc) {
    const message = `Etsy order not found in DB: ${trimmedOrderId}${options.shopId ? ` shopId=${options.shopId}` : ""}`;
    await logOrderLifecycleEvent(buildOrderLifecyclePayload({
      order: { orderId: trimmedOrderId, shopId: options.shopId || null },
      fallbackPlatform: "etsy",
      actorType: "system",
      stage: "TRACKING_PULL",
      eventType: "TRACKING_PULL_FAILED",
      status: "failed",
      reason: message,
    }));
    throw new Error(message);
  }

  const vpidSet = new Set();
  for (const it of doc.items || []) {
    const vpid = it?.cost_breakdown?.vendorProductId;
    if (vpid) vpidSet.add(String(vpid));
  }

  const vpidToVendor =
    options.vpidToVendorPrefetched || (await buildVendorMapsFromVpidSet(vpidSet));
  doc.__vpidToVendor = vpidToVendor;

  const vendorKeys = getSentTrackingVendorKeys(doc);
  doc.__sentTrackingVendorKeys = vendorKeys;

  if (vendorKeys.length === 0) {
    throw new Error(
      `No sent vendor submission found for Etsy tracking pull: ${trimmedOrderId}`
    );
  }

  let totalChanged = 0;
  const vendorResults = [];

  for (const vk of vendorKeys) {
    try {
      const result = await fetchTrackingByVendorKey(vk, trimmedOrderId, doc);
      const changed = applyToEtsyItemsOfVendor(doc, vk, result);
      totalChanged += changed;
      vendorResults.push({
        vendorKey: vk,
        ok: true,
        changed,
        tracking: result.tracking || "",
        carrier: result.carrier || "",
        shipped: !!result.shipped,
      });
    } catch (e) {
      vendorResults.push({ vendorKey: vk, ok: false, message: e.message });
    }
  }

  const allShipped =
    (doc.items || []).length > 0 &&
    (doc.items || []).every((it) => lower(it?.tracking_info?.status) === "shipped");
  let orderStatusChanged = false;
  if (allShipped && doc.status !== "Shipped") {
    doc.status = "Shipped";
    doc.shippedAt = doc.shippedAt || new Date();
    orderStatusChanged = true;
  }

  if (totalChanged > 0 || orderStatusChanged || doc.__trackingPullCostChanged) {
    await doc.save();
    await logOrderLifecycleEvent(buildOrderLifecyclePayload({
      order: doc,
      fallbackPlatform: "etsy",
      actorType: "system",
      stage: "TRACKING_PULL",
      eventType: "TRACKING_UPDATED",
      status: "success",
      metadata: {
        updatedItems: totalChanged,
        orderStatusChanged,
        vendorResults: vendorResults.map((result) => ({
          vendorKey: result.vendorKey,
          ok: result.ok,
          changed: result.changed || 0,
          shipped: !!result.shipped,
          message: result.message || "",
        })),
        costChanged: !!doc.__trackingPullCostChanged,
      },
    }));
  }
  return {
    updatedItems: totalChanged,
    orderStatusChanged,
    skipped: totalChanged === 0 && !orderStatusChanged,
    vendorResults,
  };
}

async function runEtsyVendorBatch({ max = 1100, dryRun = false, shopId = null, status = "Fulfilled", sentAfter = null, sentWithinDays = null } = {}) {
  const trackingSentAfter = getTrackingSentAfter({ sentAfter, sentWithinDays });
  const query = {
    ...buildSentVendorSubmissionQuery(trackingSentAfter),
  };
  if (status) query.status = status;
  if (shopId) query.shopId = shopId;

  const candidates = await EtsyOrder.find(query)
    .sort({ createdAt: -1 })
    .limit(max)
    .lean();

  const vpidSet = new Set();
  for (const o of candidates) {
    for (const it of o.items || []) {
      const vpid = it?.cost_breakdown?.vendorProductId;
      if (vpid) vpidSet.add(String(vpid));
    }
  }

  const vpidToVendor = await buildVendorMapsFromVpidSet(vpidSet);
  const filtered = candidates.filter((o) => {
    return getSentTrackingVendorKeys(o, { sentAfter: trackingSentAfter }).length > 0;
  });

  if (dryRun) {
    return {
      ok: true,
      mode: "dry-run",
      scanned: filtered.length,
      orderIds: filtered.map((o) => o.orderId),
      sentAfter: trackingSentAfter.toISOString(),
      vendorsPerOrder: filtered.map((o) => {
        return {
          orderId: o.orderId,
          shopId: String(o.shopId || ""),
          vendorKeys: getSentTrackingVendorKeys(o, { sentAfter: trackingSentAfter }),
        };
      }),
    };
  }

  let ok = 0;
  let fail = 0;
  const details = [];

  for (const o of filtered) {
    try {
      const result = await updateEtsyOrderByVendors(o.orderId, {
        shopId: o.shopId,
        vpidToVendorPrefetched: vpidToVendor,
      });
      ok++;
      details.push({ orderId: o.orderId, shopId: String(o.shopId || ""), ok: true, ...result });
    } catch (err) {
      fail++;
      details.push({ orderId: o.orderId, shopId: String(o.shopId || ""), ok: false, message: err.message });
    }
  }

  return { ok, fail, scanned: filtered.length, details };
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
  try {
    const { max = 1100, dryRun = false, sentAfter = null, sentWithinDays = null } = req.body || {};
    const result = await runBatch({
      max: Number(max) || 100,
      dryRun: Boolean(dryRun),
      sentAfter,
      sentWithinDays,
    });
    return res.json({ ok: true, processedOrders: result.scanned, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};

/**
 * POST /api/ext/etsy/vendor-sync/one
 * body: { orderId: "xxx", shopId?: "..." }
 */
const etsyVendorSyncOne = async (req, res) => {
  try {
    const { orderId, shopId } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ ok: false, message: "orderId required" });
    }

    const result = await updateEtsyOrderByVendors(orderId, { shopId });
    return res.json({ ok: true, orderId, ...(shopId ? { shopId } : {}), ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};

/**
 * POST /api/ext/etsy/vendor-sync/list
 * body: { orderIds: ["...", "..."], shopId?: "..." }
 */
const etsyVendorSyncList = async (req, res) => {
  try {
    const { orderIds = [], shopId } = req.body || {};
    if (!Array.isArray(orderIds) || !orderIds.length) {
      return res
        .status(400)
        .json({ ok: false, message: "orderIds[] required" });
    }

    let ok = 0;
    let fail = 0;
    const details = [];

    for (const id of orderIds) {
      try {
        const r = await updateEtsyOrderByVendors(id, { shopId });
        details.push({ orderId: id, ...(shopId ? { shopId } : {}), ok: true, ...r });
        ok++;
      } catch (err) {
        details.push({ orderId: id, ...(shopId ? { shopId } : {}), ok: false, message: err.message });
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
 * POST /api/ext/etsy/vendor-sync/batch
 * body: { max?: number, dryRun?: boolean, shopId?: string, status?: string }
 */
const etsyVendorSyncBatch = async (req, res) => {
  try {
    const { max = 1100, dryRun = false, shopId = null, status = "Fulfilled", sentAfter = null, sentWithinDays = null } = req.body || {};
    const result = await runEtsyVendorBatch({
      max: Number(max) || 100,
      dryRun: isForceTrue(dryRun),
      shopId,
      status,
      sentAfter,
      sentWithinDays,
    });
    return res.json({ ok: true, processedOrders: result.scanned, ...result });
  } catch (e) {
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
  const broadcastTaskId = buildTaskId({ type, shopId: "broadcast", payload });
  const task = { taskId: broadcastTaskId, type, payload: { ...(payload || {}), taskId: broadcastTaskId }, sentAt: new Date().toISOString() };
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
    console.log(`🚀 [REQUEST-EXT][${startTime.toISOString()}] Starting requestExtension`);
    console.log(`📋 [REQUEST-EXT] Type: ${isAutoCall ? '🤖 AUTO' : '👤 MANUAL'}`);
    
    const rawBody = req.body || {};
    const rawType = String(rawBody.type || "").toUpperCase();
    const shouldNormalizeEtsyTracking = ["ETSY_UPLOAD_TRACKING", "UPLOAD_TRACKING"].includes(rawType);
    const normalizedBody = shouldNormalizeEtsyTracking
      ? normalizeEtsyUploadTrackingBody({ ...rawBody, type: rawType })
      : { ok: true, body: rawBody };

    if (!normalizedBody.ok) {
      return res.status(400).json({ ok: false, message: normalizedBody.message });
    }

    const {
      shopId,
      machineId,
      action = "click",
      label = null,
      type,
      payload,
      taskId: providedTaskId,
    } = normalizedBody.body || {};
    
    console.log(`📋 [REQUEST-EXT] Shop: ${shopId}, Machine: ${machineId}, Task: ${type}`);
    
    if (!shopId || !machineId) {
      console.log(`❌ [REQUEST-EXT] Missing required fields: shopId=${shopId}, machineId=${machineId}`);
      return res
        .status(400)
        .json({ ok: false, message: "shopId & machineId required" });
    }

    const io = req.app.get("io");
    if (!io) return res.status(500).json({ ok: false, message: "io missing" });

    const taskId = providedTaskId || buildTaskId({ type, shopId, machineId, payload });
    console.log(`📤 [REQUEST-EXT] Sending task ${taskId} to machine:${machineId}`, { type, payload });

    const emitted = await emitTaskToMachine(io, {
      taskId,
      type,
      shopId,
      machineId,
      payload,
    });
    console.log(`✅ [REQUEST-EXT] Task emitted successfully (taskId=${emitted.taskId})`);

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
      case "ETSY_UPLOAD_TRACKING":
        message = "Start Etsy upload tracking ...";
        break;
      default:
        message = `Start ${type} ...`;
        break;
    }

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

    const responseBody = { ok: true, taskId: emitted.taskId };
    if (["ETSY_UPLOAD_TRACKING", "UPLOAD_TRACKING"].includes(String(type || "").toUpperCase())) {
      responseBody.type = type;
      responseBody.machineId = machineId;
      responseBody.shopId = shopId;
    }

    return res.json(responseBody);
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
 * POST /api/ext/task-result
 * REST fallback khi socket lỗi. Idempotent theo eventId.
 * body: { eventId, taskId, status, type?, shopId?, machineId?, result?, error?, source?, reportedAt? }
 */
const taskResultRest = async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.eventId) {
      return res.status(400).json({ ok: false, message: "eventId is required" });
    }
    if (!payload.taskId) {
      return res.status(400).json({ ok: false, message: "taskId is required" });
    }
    if (!payload.status) {
      return res.status(400).json({ ok: false, message: "status is required" });
    }
    const result = await taskStatusService.upsertByEventId({
      eventId: payload.eventId,
      taskId: payload.taskId,
      type: payload.type,
      status: payload.status,
      shopId: payload.shopId,
      machineId: payload.machineId,
      result: payload.result,
      error: payload.error,
      source: payload.source || "rest_fallback",
      reportedAt: payload.reportedAt,
      rawPayload: payload,
    });

    console.log(
      `📨 [REST] /task-result ${payload.status} taskId=${payload.taskId} eventId=${payload.eventId} deduped=${result.deduped}`
    );

    return res.json({
      ok: true,
      eventId: payload.eventId,
      deduped: !!result.deduped,
    });
  } catch (e) {
    console.error("[REST] /task-result error:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
};

/**
 * POST /api/request-extension/auto-all
 * body: { type, payload, action?, label? }
 * Auto request extension cho tất cả shops
 */
const autoRequestExtensionAll = async (req, res) => {
  const startTime = new Date();
  const isAutoCall = !req.headers['user-agent']; // Auto calls không có user-agent
  
  try {
    let { type, payload, action = "auto", label = "Auto Request" } = req.body || {};
    
    if (!type) {
      return res.status(400).json({ ok: false, message: "type required" });
    }

    // ✅ Tự động thêm date cho IMPORT_ADS_SPEND (ngày hôm qua)
    if (type === "IMPORT_ADS_SPEND") {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateString = yesterday.toISOString().split('T')[0]; // Format: YYYY-MM-DD
      
      // Merge payload với date
      payload = {
        ...payload,
        date: dateString
      };
      
      console.log(`� [AUTO-REQUEST] Added date for IMPORT_ADS_SPEND: ${dateString}`);
    }

    // Log bắt đầu
    console.log(`🚀 [AUTO-REQUEST][${startTime.toISOString()}] Starting autoRequestExtensionAll`);
    console.log(`📋 [AUTO-REQUEST] Type: ${isAutoCall ? '🤖 AUTO' : '👤 MANUAL'}`);
    console.log(`📋 [AUTO-REQUEST] Task: type=${type}, action=${action}`);
    if (payload) {
      console.log(`📋 [AUTO-REQUEST] Payload:`, payload);
    }
    
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

    // const io = req.app?.get?.("io");
    // if (!io) {
    //   console.error(`❌ [AUTO-REQUEST] Socket.IO not available`);
    //   return res.status(500).json({ ok: false, message: "Socket.IO not available" });
    // }

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
        
        // Gọi requestExtension trực tiếp (không require lại)
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

const etsyUploadTracking = async (req, res) => {
  const normalized = normalizeEtsyUploadTrackingBody({
    ...(req.body || {}),
    type: "ETSY_UPLOAD_TRACKING",
    action: (req.body || {}).action || "click",
    label: (req.body || {}).label || "Upload Etsy Tracking",
  });

  if (!normalized.ok) {
    return res.status(400).json({ ok: false, message: normalized.message });
  }

  const { type, shopId, machineId, payload, force } = normalized.body;
  const taskId = buildTaskId({ type, shopId, machineId, payload });

  const duplicateSkip = await getEtsyTrackingDuplicateSkip({ taskId, force });
  if (duplicateSkip?.reason === "TASK_ALREADY_RUNNING") {
    return res.status(409).json({
      ok: false,
      reason: duplicateSkip.reason,
      taskId,
      status: duplicateSkip.status,
      message: duplicateSkip.message,
    });
  }
  if (duplicateSkip?.reason === "TASK_ALREADY_COMPLETED") {
    return res.status(200).json(duplicateSkip);
  }

  console.log("[ETSY_UPLOAD_TRACKING] Sending task", {
    type,
    machineId,
    shopId,
    orderId: payload.orderId,
    trackingNumber: payload.trackingNumber,
    taskId,
  });

  const mockReq = {
    ...req,
    body: { ...normalized.body, taskId },
    headers: req.headers || {},
    app: req.app,
  };

  return requestExtension(mockReq, res);
};

const etsyUploadTrackingBatch = async (req, res) => {
  const normalized = normalizeEtsyUploadTrackingBatchBody(req.body || {});
  if (!normalized.ok) {
    return res.status(400).json({ ok: false, message: normalized.message });
  }

  const io = req.app?.get?.("io");
  if (!io) {
    return res.status(500).json({ ok: false, message: "io missing" });
  }

  const { machineId, shopId, mongoShopId, force, items } = normalized.body;
  const type = "ETSY_UPLOAD_TRACKING";
  const batchGroupId = `etsy_upload_tracking_batch:${machineId}:${Date.now()}`;
  const results = [];

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const seenItemKeys = new Set();

  for (let index = 0; index < items.length; index += 1) {
    const rawItem = items[index] || {};
    const orderId = norm(rawItem.orderId);
    const trackingNumber = norm(rawItem.trackingNumber || rawItem.tracking_number);

    if (!orderId) {
      failed += 1;
      results.push({
        index,
        orderId,
        trackingNumber,
        ok: false,
        reason: "ORDER_ID_REQUIRED",
        message: "orderId is required",
      });
      continue;
    }
    if (!trackingNumber) {
      failed += 1;
      results.push({
        index,
        orderId,
        trackingNumber,
        ok: false,
        reason: "TRACKING_NUMBER_REQUIRED",
        message: "trackingNumber is required",
      });
      continue;
    }

    const itemKey = `${orderId}_${trackingNumber}`;
    if (seenItemKeys.has(itemKey)) {
      skipped += 1;
      results.push({
        index,
        orderId,
        trackingNumber,
        ok: true,
        skipped: true,
        reason: "DUPLICATE_IN_BATCH",
        message: "Duplicate orderId + trackingNumber in the same batch request",
      });
      continue;
    }
    seenItemKeys.add(itemKey);

    const payload = {
      machineId,
      mongoShopId,
      shopId,
      orderId,
      trackingNumber,
      batchGroupId,
      batchIndex: index,
      batchTotal: items.length,
      ...(force ? { force: true } : {}),
    };
    const taskId = buildTaskId({ type, shopId, machineId, payload });

    try {
      const duplicateSkip = await getEtsyTrackingDuplicateSkip({ taskId, force });
      if (duplicateSkip) {
        skipped += 1;
        results.push({
          index,
          orderId,
          trackingNumber,
          ok: true,
          skipped: true,
          reason: duplicateSkip.reason,
          status: duplicateSkip.status,
          taskId,
          message: duplicateSkip.message,
        });
        continue;
      }

      await emitTaskToMachine(io, {
        taskId,
        type,
        shopId,
        machineId,
        payload,
      });
      created += 1;
      results.push({
        index,
        orderId,
        trackingNumber,
        ok: true,
        taskId,
      });
    } catch (err) {
      failed += 1;
      results.push({
        index,
        orderId,
        trackingNumber,
        ok: false,
        taskId,
        reason: "EMIT_FAILED",
        message: err.message,
      });
    }
  }

  await RealtimeLog.create({
    shopId,
    machineId,
    label: "Upload Etsy Tracking Batch",
    action: "click",
    level: "info",
    message: `Start Etsy upload tracking batch: created=${created}, skipped=${skipped}, failed=${failed}`,
    ts: new Date(),
  });

  return res.json({
    ok: true,
    batchGroupId,
    machineId,
    shopId,
    total: items.length,
    created,
    skipped,
    failed,
    results,
  });
};

const getClientOnline = async (req, res) => {
  try {
    const presence = req.app.get("presence");
    const io = req.app.get("io");
    const { shopId: filterShopId, machineId: filterMachineId, q } = req.query || {};
    const liveSocketIds = io ? new Set(io.of("/").sockets.keys()) : new Set();
    const liveByShop = new Map();
    for (const client of presence?.snapshot() || []) {
      if (!client?.shopId || !client.socketId || !liveSocketIds.has(client.socketId)) continue;
      const previous = liveByShop.get(String(client.shopId));
      if (!previous || (client.lastSeen || 0) > (previous.lastSeen || 0)) liveByShop.set(String(client.shopId), client);
    }
    const shops = await Shop.find(
      { status: "Active", ...(filterShopId ? { _id: filterShopId } : {}) },
      { _id: 1, name: 1, store: 1, merchant: 1, clients: 1 }
    ).lean();
    const out = shops.map((shop) => {
      const live = liveByShop.get(String(shop._id));
      const saved = live
        ? shop.clients?.find((client) => client.clientId === live.machineId)
        : [...(shop.clients || [])].sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))[0];
      const machineId = live?.machineId || saved?.clientId || null;
      if (filterMachineId && String(machineId) !== String(filterMachineId)) return null;
      if (q && !`${shop.name} ${shop.store} ${live?.label || saved?.label || ""}`.toLowerCase().includes(String(q).toLowerCase())) return null;
      return {
        socketId: live?.socketId || null,
        clientId: machineId,
        machineId,
        label: live?.label || saved?.label || "Chưa đăng ký extension",
        version: live?.version || saved?.version || "",
        ua: live?.ua || "",
        ip: live?.ip || "",
        shopId: String(shop._id),
        shopName: shop.name || shop.store,
        merchant: shop.merchant,
        id: String(shop._id),
        connectedAt: live?.connectedAt || null,
        lastSeen: live?.lastSeen || saved?.lastSeen || null,
        disconnectedAt: live?.disconnectedAt || saved?.disconnectedAt || null,
        status: live ? "online" : saved ? "offline" : "never-connected",
      };
    }).filter(Boolean);
    return res.json({ ok: true, clients: out });
  } catch (e) {
    console.error("getClientOnline error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
};

// Test connection với client
const testConnection = async (req, res) => {
  try {
    const machineId = String(req.params.machineId || "").trim();
    const io = req.app.get("io");
    const presence = req.app.get("presence");
    if (!io) return res.status(500).json({ ok: false, message: "Socket.IO not available" });
    if (!machineId || machineId.length > 128) return res.status(400).json({ ok: false, message: "machineId không hợp lệ" });

    const liveSocketIds = new Set(io.of("/").sockets.keys());
    const client = (presence?.snapshot() || []).find((entry) =>
      String(entry?.machineId) === machineId && liveSocketIds.has(entry.socketId)
    );
    if (!client) return res.status(409).json({ ok: false, message: "Extension chưa online nên không thể test" });

    const task = await emitTaskToMachine(io, {
      type: "CONNECTION_TEST",
      shopId: client.shopId,
      machineId,
      payload: { source: "manual" },
    });

    return res.json({
      ok: true,
      taskId: task.taskId,
      message: "Đã gửi task kiểm tra tới extension"
    });
  } catch (e) {
    console.error("testConnection error:", e);
    return res.status(500).json({ ok: false, message: "Không thể gửi task kiểm tra" });
  }
};

// Broadcast message tới tất cả clients trong shop
const broadcastMessage = async (req, res) => {
  try {
    const { shopId, message, type = "info" } = req.body;
    const io = req.app.get("io");
    
    if (!io) {
      return res.status(500).json({ ok: false, message: "Socket.IO not available" });
    }

    if (!shopId || !message) {
      return res.status(400).json({ ok: false, message: "shopId and message required" });
    }

    console.log(`📢 [BROADCAST] Sending message to shop: ${shopId}`);

    // Broadcast message tới tất cả clients trong shop
    io.to(`shop:${shopId}`).emit("server:broadcast", {
      type,
      message,
      timestamp: Date.now(),
      from: "server"
    });

    // Đếm số recipients
    const room = io.of("/").adapter.rooms.get(`shop:${shopId}`);
    const recipients = room ? room.size : 0;

    return res.json({
      ok: true,
      message: "Message broadcasted successfully",
      recipients,
      shopId
    });

  } catch (e) {
    console.error("broadcastMessage error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = {
  getExtensionTask,
  requestExtension,
  getClientOnline,
  pullAllOrder,
  testConnection,
  broadcastMessage,
  taskResultRest,
  etsyUploadTracking,
  etsyUploadTrackingBatch,

  // vendor sync APIs
  vendorSyncOne,
  vendorSyncList,
  vendorSyncBatch,
  previewOrderVendorTracking,
  etsyVendorSyncOne,
  etsyVendorSyncList,
  etsyVendorSyncBatch,

  // auto request extension
  autoRequestExtensionAll,

  // nếu cần dùng nội bộ
  updateOrderByVendors,
  updateEtsyOrderByVendors,
  runBatch,
  runEtsyVendorBatch,
  pickOnosTracking,
  pickLenfulTracking,
};

