const PROVIDER_LABELS = {
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
};

function cleanTrackingString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  const s = String(value).trim();
  if (!s || /^\[object\s+Object\]$/i.test(s)) return "";
  return s;
}

function lower(value) {
  return cleanTrackingString(value).toLowerCase();
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
  const key = normalizeProviderKey(provider);
  return PROVIDER_LABELS[key] || cleanTrackingString(provider) || key;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getPayloadRoot(payload = {}) {
  if (isPlainObject(payload?.data)) return payload.data;
  if (isPlainObject(payload?.order)) return payload.order;
  return payload;
}

function firstValue(...values) {
  for (const value of values) {
    const v = cleanTrackingString(value);
    if (v) return v;
  }
  return "";
}

function parseCarrierFromNote(note) {
  const parts = cleanTrackingString(note)
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const carrierPart = parts.find((part) => /^carrier\s*:/i.test(part));
  return carrierPart ? carrierPart.replace(/^carrier\s*:/i, "").trim() : "";
}

function isValidTrackingNumber(value) {
  const t = cleanTrackingString(value);
  if (!t) return false;
  if (t === "-" || t === "---") return false;
  if (/^0+$/.test(t)) return false;
  if (!/[A-Za-z0-9]/.test(t)) return false;
  return t.length >= 8;
}

function trackingValue(value) {
  if (!isPlainObject(value)) return value;
  return firstValue(
    value.tracking_number,
    value.trackingNumber,
    value.tracking,
    value.tracking_code,
    value.trackingCode,
    value.tracking_id,
    value.trackingId,
    value.number,
    value.code
  );
}

function carrierValue(value) {
  if (!isPlainObject(value)) return "";
  return firstValue(
    value.carrier,
    value.carrier_name,
    value.carrierName,
    value.tracking_company,
    value.shipping_carrier,
    value.shippingCarrier,
    value.shipping_provider,
    value.shippingProvider
  );
}

function collectTrackingCandidates(root) {
  const candidates = [];
  const seen = new Set();

  const push = (obj = {}) => {
    if (!isPlainObject(obj)) return;
    if (seen.has(obj)) return;
    seen.add(obj);

    const trackingNumber = firstValue(
      obj.tracking_number,
      obj.trackingNumber,
      trackingValue(obj.tracking),
      obj.tracking_code,
      obj.trackingCode,
      obj.tracking_id,
      obj.trackingId,
      obj.number,
      obj.code
    );
    const carrier = firstValue(
      obj.carrier,
      carrierValue(obj.tracking),
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
    const trackingUrl = firstValue(
      obj.tracking_url,
      obj.trackingUrl,
      obj.url,
      isPlainObject(obj.tracking) ? obj.tracking.url : ""
    );
    const shippingLabel = firstValue(
      obj.shipping_label,
      obj.shippingLabel,
      obj.label_url,
      obj.labelUrl,
      isPlainObject(obj.tracking) ? obj.tracking.shipping_label || obj.tracking.shippingLabel : ""
    );
    const shipmentId = firstValue(obj.shipment_id, obj.shipmentId, obj.shipment?.id);
    const productionAt = firstValue(obj.production_at, obj.productionAt);
    const paidAt = firstValue(obj.paid_at, obj.paidAt);
    const updatedAt = firstValue(
      obj.updated_at,
      obj.updatedAt,
      obj.shipped_at,
      obj.shippedAt,
      obj.created_at,
      obj.createdAt
    );
    const updatedAtMs = updatedAt ? new Date(updatedAt).getTime() : 0;

    if (trackingNumber || carrier || status || trackingUrl || shippingLabel) {
      candidates.push({
        trackingNumber,
        carrier,
        status,
        trackingUrl,
        shippingLabel,
        shipmentId,
        productionAt,
        paidAt,
        updatedAt,
        updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
      });
    }
  };

  const pushDeep = (obj) => {
    if (!isPlainObject(obj)) return;
    push(obj);
    push(obj.data);
    push(obj.tracking);
    push(obj.order);
    push(obj.shipment);
    push(obj.shipping);

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
      const arr = obj[key];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        pushDeep(entry);
      }
    }
  };

  pushDeep(root);
  pushDeep(root?.data);
  return candidates;
}

function pickBestTracking(root) {
  const picked =
    collectTrackingCandidates(root)
      .filter(
        (candidate) =>
          isValidTrackingNumber(candidate.trackingNumber) ||
          candidate.carrier ||
          candidate.status ||
          candidate.trackingUrl ||
          candidate.shippingLabel
      )
      .sort((a, b) => {
        const aHasTracking = isValidTrackingNumber(a.trackingNumber) ? 1 : 0;
        const bHasTracking = isValidTrackingNumber(b.trackingNumber) ? 1 : 0;
        if (aHasTracking !== bHasTracking) return bHasTracking - aHasTracking;
        return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
      })[0] || {};

  return {
    trackingNumber: isValidTrackingNumber(picked.trackingNumber) ? picked.trackingNumber : "",
    carrier: picked.carrier || "",
    status: lower(picked.status),
    trackingUrl: picked.trackingUrl || "",
    shippingLabel: picked.shippingLabel || "",
    shipmentId: picked.shipmentId || "",
    productionAt: picked.productionAt || null,
    paidAt: picked.paidAt || null,
    updatedAt: picked.updatedAt || null,
  };
}

function normalizeVendorTrackingPayload(provider, payload = {}) {
  const key = normalizeProviderKey(provider);
  const root = getPayloadRoot(payload);
  const picked = pickBestTracking(payload);
  const status = picked.status || lower(root?.status || payload?.status || root?.shipment_status || root?.fulfillment_status);
  const shipped =
    ["shipped", "delivered", "fulfilled", "completed", "complete"].includes(status) ||
    Boolean(picked.trackingNumber);

  return {
    provider: key,
    fulfillment: getProviderLabel(key || provider),
    externalOrderId: firstValue(root?.external_id, payload?.external_id, root?.id, payload?.id, root?.order_id, payload?.order_id),
    orderId: firstValue(root?.referent_id, payload?.referent_id, root?.orderId, payload?.orderId, root?.order_id, payload?.order_id),
    trackingNumber: picked.trackingNumber,
    tracking: picked.trackingNumber,
    carrier: picked.carrier,
    status,
    vendorStatus: status,
    shipped,
    trackingUrl: picked.trackingUrl,
    shippingLabel: picked.shippingLabel,
    shipmentId: picked.shipmentId,
    productionAt: picked.productionAt,
    paidAt: picked.paidAt,
    updatedAt: picked.updatedAt,
    raw: payload,
  };
}

function normalizeVendorSubmissionTracking(provider, submission = {}) {
  const trackingLast = submission?.tracking_last_response || {};
  const detail = trackingLast?.detail || {};
  const detailData = isPlainObject(detail?.data) ? detail.data : isPlainObject(detail) ? detail : {};
  const shipmentEvents = trackingLast?.shipment_events || {};
  const shipmentData = isPlainObject(shipmentEvents?.data) ? shipmentEvents.data : isPlainObject(shipmentEvents) ? shipmentEvents : {};
  const lastWebhook = submission?.last_webhook || {};
  const lastWebhookData = isPlainObject(lastWebhook?.data) ? lastWebhook.data : isPlainObject(lastWebhook) ? lastWebhook : {};
  const lastResponse = submission?.last_response || {};
  const lastResponseData = isPlainObject(lastResponse?.data) ? lastResponse.data : isPlainObject(lastResponse) ? lastResponse : {};

  const normalized = normalizeVendorTrackingPayload(provider, {
    ...submission,
    data: {
      ...lastResponseData,
      ...lastWebhookData,
      ...shipmentData,
      ...detailData,
      tracking:
        detailData.tracking ||
        shipmentData.tracking ||
        lastWebhookData.tracking ||
        lastResponseData.tracking ||
        submission.webhook_tracking,
    },
    detail: detailData,
    shipment_events: shipmentData,
    last_webhook: lastWebhookData,
    last_response: lastResponseData,
  });

  const key = normalizeProviderKey(provider);
  return {
    ...normalized,
    provider: key,
    fulfillment: getProviderLabel(key || provider),
    externalOrderId: firstValue(
      submission.external_id,
      normalized.externalOrderId,
      detailData.id,
      shipmentData.id,
      lastWebhookData.id,
      lastResponseData.id
    ),
    vendorStatus: firstValue(submission.tracking_status, normalized.vendorStatus, submission.webhook_status),
    trackingNumber: firstValue(normalized.trackingNumber, submission.webhook_tracking),
    tracking: firstValue(normalized.trackingNumber, submission.webhook_tracking),
    carrier: firstValue(normalized.carrier, submission.webhook_carrier),
  };
}

module.exports = {
  cleanTrackingString,
  collectTrackingCandidates,
  getProviderLabel,
  isValidTrackingNumber,
  normalizeProviderKey,
  normalizeVendorSubmissionTracking,
  normalizeVendorTrackingPayload,
  parseCarrierFromNote,
};
