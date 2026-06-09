const mongoose = require("mongoose");
const db = require("../models");

const EtsyOrder = db.EtsyOrder || mongoose.model("EtsyOrder");
const OrderCustomProduct = db.orderCustomProduct || mongoose.model("OrderCustomProduct");
const VendorProduct = db.vendorProduct || mongoose.model("VendorProduct");
const Vendor = db.vendor || mongoose.model("Vendor");

function norm(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function lower(value) {
  return norm(value).toLowerCase();
}

function normalizeProviderKey(value) {
  const s = lower(value);
  if (!s) return "";
  if (s.includes("grabink") || s.includes("beeful")) return "grabink";
  if (s.includes("merchfox") || s.includes("merch fox")) return "merchfox";
  if (s.includes("merchize")) return "merchize";
  if (s.includes("printway") || s.includes("print way") || s === "pw") return "printway";
  if (s.includes("mangotee") || s.includes("mango tee")) return "mangotee";
  if (s.includes("ss88") || s.includes("mmoseller")) return "ss88";
  if (s.includes("luxurypro") || s.includes("luxury pro")) return "luxurypro";
  if (s.includes("onos")) return "onos";
  if (s.includes("lenful")) return "lenful";
  if (s.includes("pgprint")) return "pgprint";
  if (s.includes("lng")) return "lng";
  return s;
}

function getProviderLabel(provider) {
  return (
    {
      grabink: "Grabink",
      merchfox: "MerchFox",
      merchize: "Merchize",
      printway: "Printway",
      mangotee: "MangoTee",
      ss88: "SS88",
      luxurypro: "LuxuryPro",
      onos: "Onos",
      lenful: "Lenful",
      pgprint: "PGPrint",
      lng: "LNG",
    }[provider] || provider
  );
}

function isValidTrackingNumber(value) {
  const t = norm(value);
  if (!t) return false;
  if (t === "-" || t === "---") return false;
  if (/^0+$/.test(t)) return false;
  if (!/[A-Za-z0-9]/.test(t)) return false;
  return t.length >= 8;
}

function firstValue(...values) {
  for (const value of values) {
    const v = norm(value);
    if (v) return v;
  }
  return "";
}

function collectTrackingCandidates(root) {
  const candidates = [];

  const push = (obj = {}) => {
    if (!obj || typeof obj !== "object") return;

    const tracking = firstValue(
      obj.tracking_number,
      obj.trackingNumber,
      obj.tracking,
      obj.tracking_code,
      obj.trackingCode,
      obj.tracking_id,
      obj.trackingId
    );
    const carrier = firstValue(
      obj.carrier,
      obj.carrier_name,
      obj.carrierName,
      obj.tracking_company,
      obj.shipping_carrier,
      obj.shippingCarrier,
      obj.shipping_provider,
      obj.shippingProvider
    );
    const status = firstValue(
      obj.status,
      obj.shipment_status,
      obj.fulfillment_status,
      obj.production_status
    );
    const updatedAtMs = new Date(
      obj.updated_at ||
        obj.updatedAt ||
        obj.shipped_at ||
        obj.shippedAt ||
        obj.created_at ||
        obj.createdAt ||
        0
    ).getTime();

    if (tracking || carrier || status) {
      candidates.push({ tracking, carrier, status, updatedAtMs });
    }
  };

  push(root);
  push(root?.data);
  push(root?.tracking);
  push(root?.shipment);
  push(root?.shipping);
  push(root?.data?.tracking);
  push(root?.data?.shipment);
  push(root?.data?.shipping);

  for (const parent of [root, root?.data]) {
    if (!parent || typeof parent !== "object") continue;
    for (const key of [
      "trackings",
      "tracking_list",
      "shipments",
      "shipment_events",
      "events",
      "fulfillments",
      "items",
      "line_items",
    ]) {
      const arr = parent[key];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        push(entry);
        push(entry?.tracking);
        push(entry?.shipment);
      }
    }
  }

  return candidates;
}

function pickTracking(root) {
  const picked =
    collectTrackingCandidates(root)
      .filter((candidate) => isValidTrackingNumber(candidate.tracking) || candidate.carrier || candidate.status)
      .sort((a, b) => {
        const aHasTracking = isValidTrackingNumber(a.tracking) ? 1 : 0;
        const bHasTracking = isValidTrackingNumber(b.tracking) ? 1 : 0;
        if (aHasTracking !== bHasTracking) return bHasTracking - aHasTracking;
        return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
      })[0] || {};

  const tracking = isValidTrackingNumber(picked.tracking) ? picked.tracking : "";
  const carrier = picked.carrier || "";
  const status = lower(
    picked.status ||
      root?.status ||
      root?.data?.status ||
      root?.shipment_status ||
      root?.data?.shipment_status ||
      root?.fulfillment_status ||
      root?.data?.fulfillment_status
  );
  const shipped =
    ["shipped", "delivered", "fulfilled", "completed", "complete"].includes(status) || Boolean(tracking);

  return { tracking, carrier, status, shipped };
}

function parseOnosWebhook(payload = {}) {
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const tracking = pickTracking(payload);

  return {
    provider: "onos",
    externalId: firstValue(data.id, payload.id, data.order_id, payload.order_id),
    orderId: firstValue(data.referent_id, payload.referent_id, data.order_id, payload.order_id, data.orderId, payload.orderId),
    tracking: tracking.tracking,
    carrier: tracking.carrier,
    status: tracking.status || lower(data.status || payload.status),
    shipped: tracking.shipped,
    raw: payload,
  };
}

function parseGenericWebhook(provider, payload = {}) {
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const tracking = pickTracking(payload);

  return {
    provider,
    externalId: firstValue(data.external_id, payload.external_id, data.id, payload.id, data.order_id, payload.order_id),
    orderId: firstValue(data.referent_id, payload.referent_id, data.orderId, payload.orderId, data.order_id, payload.order_id),
    tracking: tracking.tracking,
    carrier: tracking.carrier,
    status: tracking.status || lower(data.status || payload.status),
    shipped: tracking.shipped,
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
      updated_at: now,
    };

    if (
      next.tracking !== prevTracking ||
      next.status !== prevStatus ||
      next.fulfillment !== prev.fulfillment ||
      next.note !== prev.note
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
    norm(req.headers?.["x-provider-webhook-token"]) ||
    norm(req.headers?.["x-vendor-webhook-token"]) ||
    norm(req.query?.token)
  );
}

function verifyWebhookSecret(req, provider) {
  const envName = `${provider.toUpperCase()}_WEBHOOK_SECRET`;
  const expected = norm(process.env[envName] || process.env.VENDOR_WEBHOOK_SECRET);
  if (!expected) return;

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
