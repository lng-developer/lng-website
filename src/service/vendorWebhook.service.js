const crypto = require("crypto");
const mongoose = require("mongoose");
const db = require("../models");
const {
  cleanTrackingString,
  getProviderLabel: getNormalizedProviderLabel,
  isValidTrackingNumber: isNormalizedTrackingNumber,
  normalizeProviderKey: normalizeTrackingProviderKey,
  normalizeVendorTrackingPayload,
} = require("./vendorTrackingNormalizer.service");

const EtsyOrder = db.EtsyOrder || mongoose.model("EtsyOrder");
const OrderCustomProduct = db.orderCustomProduct || mongoose.model("OrderCustomProduct");
const VendorProduct = db.vendorProduct || mongoose.model("VendorProduct");
const Vendor = db.vendor || mongoose.model("Vendor");
const FulfillmentLifecycleEvent = db.FulfillmentLifecycleEvent || mongoose.model("FulfillmentLifecycleEvent");

const FULFILLMENT_LIFECYCLE_EVENT_TYPES = new Set([
  "fulfillment.accepted",
  "shipment.created",
  "shipment.label_ready",
  "tracking.updated",
  "shipment.carrier_handoff_confirmed",
  "shipment.cancelled",
  "shipment.failed",
]);
const FULFILLMENT_LIFECYCLE_MAX_AGE_SECONDS = 5 * 60;
const FULFILLMENT_LIFECYCLE_RANK = {
  "fulfillment.accepted": 1,
  "shipment.created": 2,
  "shipment.label_ready": 3,
  "tracking.updated": 4,
  "shipment.carrier_handoff_confirmed": 5,
  "shipment.cancelled": 6,
  "shipment.failed": 6,
};

function norm(value) {
  return cleanTrackingString(value);
}

function lower(value) {
  return norm(value).toLowerCase();
}

function normalizeProviderKey(value) {
  return normalizeTrackingProviderKey(value);
}

function getProviderLabel(provider) {
  return getNormalizedProviderLabel(provider);
}

function isValidTrackingNumber(value) {
  return isNormalizedTrackingNumber(value);
}

function firstValue(...values) {
  for (const value of values) {
    const v = norm(value);
    if (v) return v;
  }
  return "";
}

function pickTracking(root) {
  const normalized = normalizeVendorTrackingPayload("", root);
  return {
    tracking: normalized.trackingNumber,
    carrier: normalized.carrier,
    status: normalized.status,
    shipped: normalized.shipped,
  };
}

function parseOnosWebhook(payload = {}) {
  const tracking = normalizeVendorTrackingPayload("onos", payload);

  return {
    provider: "onos",
    externalId: tracking.externalOrderId,
    orderId: tracking.orderId,
    tracking: tracking.trackingNumber,
    carrier: tracking.carrier,
    status: tracking.status,
    shipped: tracking.shipped,
    raw: payload,
  };
}

function parseGenericWebhook(provider, payload = {}) {
  const tracking = normalizeVendorTrackingPayload(provider, payload);

  return {
    provider,
    externalId: tracking.externalOrderId,
    orderId: tracking.orderId,
    tracking: tracking.trackingNumber,
    carrier: tracking.carrier,
    status: tracking.status,
    shipped: tracking.shipped,
    raw: payload,
  };
}

function parseMerchizeWebhook(payload = {}) {
  const resource = payload?.resource || {};
  const history = Array.isArray(resource.shipment_histories)
    ? resource.shipment_histories.at(-1)
    : resource.shipment_histories || {};
  const event = firstValue(history.message, history.status, resource.new_shipment_status);
  const rawTime = norm(history.date);
  const actualShipAt = rawTime ? new Date(rawTime) : null;
  const isCarrierHandoff =
    lower(resource.new_shipment_status) === "in_transit" &&
    Number.isFinite(actualShipAt?.getTime());

  return {
    provider: "merchize",
    externalId: norm(resource.order_code),
    orderId: norm(resource.external_number),
    tracking: firstValue(resource.tracking_number, resource.trackingNumber),
    carrier: firstValue(resource.tracking_company, resource.carrier),
    status: norm(resource.new_shipment_status),
    shipped: isCarrierHandoff,
    actualShipAt: isCarrierHandoff ? actualShipAt : null,
    shipEvidence: isCarrierHandoff
      ? {
          provider: "merchize",
          event,
          location: norm(history.location),
          eventAt: actualShipAt.toISOString(),
        }
      : null,
    raw: payload,
  };
}

function parseWebhook(provider, payload = {}) {
  const key = normalizeProviderKey(provider);
  if (!key) {
    const err = new Error("Unknown webhook provider");
    err.status = 400;
    throw err;
  }
  if (key === "onos") return parseOnosWebhook(payload);
  if (key === "merchize") return parseMerchizeWebhook(payload);
  return parseGenericWebhook(key, payload);
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

async function buildItemProviderMap(items = []) {
  const ids = [
    ...new Set(
      items
        .map((item) => norm(item?.cost_breakdown?.vendorProductId))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];
  if (!ids.length) return new Map();

  const vendorProducts = await VendorProduct.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select({ _id: 1, vendor_id: 1 })
    .lean();

  const vendorIds = [...new Set(vendorProducts.map((vp) => norm(vp.vendor_id)).filter(Boolean))];
  const vendors = vendorIds.length
    ? await Vendor.find({ _id: { $in: vendorIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select({ _id: 1, name: 1, fulfillment_type: 1 })
        .lean()
    : [];

  const vendorById = new Map(vendors.map((vendor) => [String(vendor._id), vendor]));
  const providerByVendorProductId = new Map();
  for (const vendorProduct of vendorProducts) {
    const vendor = vendorById.get(String(vendorProduct.vendor_id));
    providerByVendorProductId.set(
      String(vendorProduct._id),
      normalizeProviderKey(vendor?.fulfillment_type) || normalizeProviderKey(vendor?.name)
    );
  }

  return providerByVendorProductId;
}

async function findOrderForEvent(provider, event) {
  const externalId = norm(event.externalId);
  const orderId = norm(event.orderId);
  const dynamicExternalPath = `vendor_submissions.${provider}.external_id`;

  const modelCandidates = [
    { kind: "etsy", model: EtsyOrder },
    { kind: "order", model: OrderCustomProduct },
  ];

  const queryCandidates = [];
  if (externalId) {
    queryCandidates.push({ [dynamicExternalPath]: externalId });
    queryCandidates.push({ external_order_id: externalId });
  }
  if (orderId) queryCandidates.push({ orderId });

  for (const query of queryCandidates) {
    for (const candidate of modelCandidates) {
      const doc = await candidate.model.findOne(query);
      if (doc) return { ...candidate, doc };
    }
  }

  return null;
}

async function applyWebhookToOrder(provider, event, found) {
  const { doc, kind } = found;
  const providerByVendorProductId = await buildItemProviderMap(doc.items || []);
  const hasProviderMap = providerByVendorProductId.size > 0;
  const label = getProviderLabel(provider);
  const now = new Date();
  let changedItems = 0;
  let matchedItems = 0;

  doc.items = (doc.items || []).map((item) => {
    const itemObj = item.toObject?.() ? item.toObject() : item;
    const vpid = norm(itemObj?.cost_breakdown?.vendorProductId);
    const itemProvider = vpid ? providerByVendorProductId.get(vpid) : "";
    const shouldUpdate = hasProviderMap ? itemProvider === provider : true;
    if (!shouldUpdate) return itemObj;
    matchedItems += 1;

    const prev = itemObj.tracking_info || {};
    const prevTracking = norm(prev.tracking);
    const prevStatus = norm(prev.status);
    const nextTracking = event.tracking || prevTracking;
    const nextStatus = event.shipped ? "Shipped" : prevStatus || "New";
    const next = {
      ...prev,
      fulfillment: label,
      tracking: nextTracking,
      status: nextStatus,
      note: buildTrackingNote(prev.note, event.carrier),
      ...(event.actualShipAt && !prev.actualShipAt
        ? { actualShipAt: event.actualShipAt, shipEvidence: event.shipEvidence }
        : {}),
      updated_at: now,
    };

    if (
      next.tracking !== prevTracking ||
      next.status !== prevStatus ||
      next.fulfillment !== prev.fulfillment ||
      next.note !== prev.note
      || String(next.actualShipAt || "") !== String(prev.actualShipAt || "")
      || JSON.stringify(next.shipEvidence || null) !== JSON.stringify(prev.shipEvidence || null)
    ) {
      changedItems += 1;
    }

    return { ...itemObj, tracking_info: next };
  });

  const allShipped =
    (doc.items || []).length > 0 &&
    (doc.items || []).every((item) => lower(item?.tracking_info?.status) === "shipped");
  let orderStatusChanged = false;
  if (allShipped && doc.status !== "Shipped") {
    doc.status = "Shipped";
    if (kind === "etsy" && !doc.shippedAt) doc.shippedAt = now;
    orderStatusChanged = true;
  }

  const hasChanges = changedItems > 0 || orderStatusChanged;
  if (hasChanges) {
    doc.vendor_submissions = doc.vendor_submissions || {};
    doc.vendor_submissions[provider] = {
      ...(doc.vendor_submissions[provider] || {}),
      last_webhook: event.raw,
      webhook_received_at: now,
      webhook_attempt_count: (doc.vendor_submissions[provider]?.webhook_attempt_count || 0) + 1,
      webhook_status: event.status || "",
      webhook_tracking: event.tracking || "",
      webhook_carrier: event.carrier || "",
    };

    if (typeof doc.markModified === "function") {
      doc.markModified("items");
      doc.markModified("vendor_submissions");
    }

    await doc.save();
  }

  return {
    collection: kind === "etsy" ? "etsyorders" : "ordercustomproducts",
    orderId: doc.orderId,
    matchedItems,
    changedItems,
    orderStatusChanged,
    skipped: !hasChanges,
    tracking: event.tracking || "",
    carrier: event.carrier || "",
    shipped: !!event.shipped,
  };
}

function extractSecretFromRequest(req) {
  const auth = norm(req.headers?.authorization);
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return (
    norm(req.headers?.["x-webhook-token"]) ||
    norm(req.headers?.["merchize-webhook-key"]) ||
    norm(req.headers?.["x-provider-webhook-token"]) ||
    norm(req.headers?.["x-vendor-webhook-token"]) ||
    norm(req.query?.token)
  );
}

function getRawRequestBody(req) {
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody;
  if (typeof req?.rawBody === "string") return Buffer.from(req.rawBody, "utf8");
  return Buffer.from(JSON.stringify(req?.body || {}), "utf8");
}

function normalizeHmacSignature(value) {
  return norm(value)
    .replace(/^sha256=/i, "")
    .replace(/^hmac-sha256=/i, "")
    .trim();
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function fulfillmentWebhookError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function verifyFulfillmentLifecycleWebhook(req) {
  const secret = norm(process.env.FULFILLMENT_LIFECYCLE_WEBHOOK_SECRET);
  if (!secret) throw fulfillmentWebhookError("Fulfillment lifecycle webhook is not configured", 503);

  const timestamp = norm(req?.headers?.["x-lng-event-timestamp"]);
  const signature = normalizeHmacSignature(req?.headers?.["x-lng-signature"]);
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > FULFILLMENT_LIFECYCLE_MAX_AGE_SECONDS) {
    throw fulfillmentWebhookError("Invalid or expired lifecycle webhook timestamp", 401);
  }
  if (!signature) throw fulfillmentWebhookError("Invalid lifecycle webhook signature", 401);

  const expected = crypto.createHmac("sha256", secret).update(getRawRequestBody(req)).digest("hex");
  if (!timingSafeStringEqual(signature, expected)) {
    throw fulfillmentWebhookError("Invalid lifecycle webhook signature", 401);
  }
}

function validateFulfillmentLifecyclePayload(payload = {}) {
  const required = ["eventId", "eventType", "occurredAt", "tenantReference", "externalOrderId", "fulfillmentOrderId"];
  if (!payload || typeof payload !== "object" || required.some((key) => !norm(payload[key]))) {
    throw fulfillmentWebhookError("Invalid fulfillment lifecycle event", 400);
  }
  if (!FULFILLMENT_LIFECYCLE_EVENT_TYPES.has(payload.eventType) || Number.isNaN(new Date(payload.occurredAt).getTime())) {
    throw fulfillmentWebhookError("Unsupported or invalid fulfillment lifecycle event", 400);
  }
}

async function findFulfillmentLifecycleOrder(externalOrderId) {
  const query = { orderId: externalOrderId };
  return (await EtsyOrder.findOne(query)) || (await OrderCustomProduct.findOne(query));
}

function applyFulfillmentLifecycleEvent(order, payload, now = new Date()) {
  const previous = order.vendor_submissions?.fulfillment_platform_v2 || {};
  const eventAt = new Date(payload.occurredAt);
  const previousAt = previous.occurred_at ? new Date(previous.occurred_at) : null;
  const previousRank = FULFILLMENT_LIFECYCLE_RANK[previous.event_type] || 0;
  const nextRank = FULFILLMENT_LIFECYCLE_RANK[payload.eventType];
  if ((previousAt && eventAt < previousAt) || nextRank < previousRank) return { skipped: true };

  const shipment = payload.shipment || {};
  order.vendor_submissions = order.vendor_submissions || {};
  order.vendor_submissions.fulfillment_platform_v2 = {
    ...previous,
    fulfillment_order_id: payload.fulfillmentOrderId,
    event_type: payload.eventType,
    occurred_at: eventAt,
    ...(shipment.shipmentId ? { shipment_id: shipment.shipmentId } : {}),
    ...(shipment.carrierShipmentId ? { carrier_shipment_id: shipment.carrierShipmentId } : {}),
    ...(shipment.carrierCode ? { carrier: shipment.carrierCode } : {}),
    ...(shipment.trackingNumber ? { tracking: shipment.trackingNumber } : {}),
    ...(shipment.labelUrl ? { label_url: shipment.labelUrl } : {}),
    ...(payload.failure?.code ? { failure_code: payload.failure.code } : {}),
    updated_at: now,
  };
  if (typeof order.markModified === "function") order.markModified("vendor_submissions");

  if (payload.eventType !== "shipment.carrier_handoff_confirmed") return { skipped: false, handoffConfirmed: false };
  const actualShipAt = new Date(shipment.actualShipAt || payload.occurredAt);
  if (Number.isNaN(actualShipAt.getTime())) return { skipped: false, handoffConfirmed: false };
  order.items = (order.items || []).map((item) => {
    const trackingInfo = item.tracking_info || {};
    const matchesShipment = !trackingInfo.tracking || trackingInfo.tracking === shipment.trackingNumber;
    if (!matchesShipment) return item;
    return {
      ...item,
      tracking_info: {
        ...trackingInfo,
        fulfillment: "Fulfillment Platform V2",
        ...(shipment.trackingNumber ? { tracking: shipment.trackingNumber } : {}),
        ...(shipment.carrierCode ? { carrier: shipment.carrierCode } : {}),
        status: "Shipped",
        ...(trackingInfo.actualShipAt ? {} : {
          actualShipAt,
          shipEvidence: { provider: "fulfillment-platform-v2", shipmentId: shipment.shipmentId || "" },
        }),
        updated_at: now,
      },
    };
  });
  if (typeof order.markModified === "function") order.markModified("items");
  return { skipped: false, handoffConfirmed: true };
}

async function handleFulfillmentLifecycleWebhook({ payload, req }) {
  verifyFulfillmentLifecycleWebhook(req);
  validateFulfillmentLifecyclePayload(payload);

  if (await FulfillmentLifecycleEvent.findOne({ eventId: payload.eventId })) {
    return { ok: true, duplicate: true };
  }

  const order = await findFulfillmentLifecycleOrder(payload.externalOrderId);
  if (!order) throw fulfillmentWebhookError("Fulfillment lifecycle order not found", 404);

  applyFulfillmentLifecycleEvent(order, payload);
  if (typeof order.save === "function") await order.save();

  try {
    await FulfillmentLifecycleEvent.create({
      eventId: payload.eventId,
      eventType: payload.eventType,
      tenantReference: payload.tenantReference,
      externalOrderId: payload.externalOrderId,
      fulfillmentOrderId: payload.fulfillmentOrderId,
      occurredAt: new Date(payload.occurredAt),
      receivedAt: new Date(),
    });
  } catch (err) {
    if (err?.code === 11000) return { ok: true, duplicate: true };
    throw err;
  }

  return { ok: true, duplicate: false };
}

function verifyOnosHmac(req, expectedSecret) {
  const received = normalizeHmacSignature(req.headers?.["x-onos-hmac-sha256"]);
  if (!received) return false;

  const rawBody = getRawRequestBody(req);
  const digestHex = crypto
    .createHmac("sha256", expectedSecret)
    .update(rawBody)
    .digest("hex");
  const digestBase64 = crypto
    .createHmac("sha256", expectedSecret)
    .update(rawBody)
    .digest("base64");

  return (
    timingSafeStringEqual(received, digestHex) ||
    timingSafeStringEqual(received, digestBase64)
  );
}

function verifyWebhookSecret(req, provider) {
  const envName = `${provider.toUpperCase()}_WEBHOOK_SECRET`;
  const expected = norm(process.env[envName] || process.env.VENDOR_WEBHOOK_SECRET);
  if (!expected) return;

  if (provider === "onos" && verifyOnosHmac(req, expected)) return;

  const received = extractSecretFromRequest(req);
  if (received !== expected) {
    const err = new Error("Invalid webhook secret");
    err.status = 401;
    throw err;
  }
}

async function handleWebhook({ provider, payload, req }) {
  const key = normalizeProviderKey(provider);
  verifyWebhookSecret(req, key);

  const event = parseWebhook(key, payload);
  const found = await findOrderForEvent(key, event);
  if (!found) {
    const err = new Error("Webhook order not found");
    err.status = 404;
    err.event = {
      provider: key,
      externalId: event.externalId || "",
      orderId: event.orderId || "",
    };
    throw err;
  }

  const result = await applyWebhookToOrder(key, event, found);
  return {
    ok: true,
    provider: key,
    event: {
      externalId: event.externalId || "",
      orderId: event.orderId || "",
      status: event.status || "",
      tracking: event.tracking || "",
      carrier: event.carrier || "",
      shipped: !!event.shipped,
    },
    result,
  };
}

module.exports = {
  handleFulfillmentLifecycleWebhook,
  applyFulfillmentLifecycleEvent,
  handleWebhook,
  parseWebhook,
  parseOnosWebhook,
  applyWebhookToOrder,
  _helpers: {
    normalizeProviderKey,
    pickTracking,
    isValidTrackingNumber,
    buildTrackingNote,
  },
};
