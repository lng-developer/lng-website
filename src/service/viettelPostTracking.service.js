const HANDOFF_CODES = new Set([200, 300, 400]);

function normalize(value) {
  return String(value || "").trim();
}

function matchesShipmentTracking(shipmentTracking, localTracking) {
  const shipment = normalize(shipmentTracking);
  const local = normalize(localTracking);
  return Boolean(local) && (shipment === local || shipment.endsWith(local));
}

function trackingLookupValues(trackingNumbers = []) {
  const values = new Set();
  for (const trackingNumber of trackingNumbers) {
    const tracking = normalize(trackingNumber);
    if (!tracking) continue;
    values.add(tracking);
    for (let length = 8; length <= Math.min(30, tracking.length); length += 1) {
      values.add(tracking.slice(-length));
    }
  }
  return [...values];
}

function recentShipments(shipments = [], since) {
  const start = new Date(since);
  return shipments.filter((shipment) => {
    const createdAt = new Date(shipment?.dateCreate);
    return !Number.isNaN(createdAt.getTime()) && createdAt >= start;
  });
}

function normalizeCarrier(value) {
  const carrier = normalize(value);
  return carrier ? carrier.toUpperCase() : "";
}

function firstCarrierHandoff(activities = []) {
  return activities
    .filter((activity) => HANDOFF_CODES.has(Number(activity?.code)))
    .map((activity) => ({ ...activity, eventAt: new Date(activity.dateCreate) }))
    .filter((activity) => !Number.isNaN(activity.eventAt.getTime()))
    .sort((a, b) => a.eventAt - b.eventAt)[0] || null;
}

function buildTrackingSync(shipment = {}, detail = {}) {
  const handoff = firstCarrierHandoff(detail.activitiesTimeline);
  return {
    carrier: normalizeCarrier(shipment.shipBy),
    shipmentId: normalize(shipment.id),
    shipmentCode: normalize(shipment.shipmentCode),
    tracking: normalize(shipment.trackingNumber),
    actualShipAt: handoff?.eventAt || null,
    shipEvidence: handoff
      ? {
          provider: "viettelpost",
          activityCode: Number(handoff.code),
          activity: normalize(handoff.activity),
          eventAt: handoff.eventAt.toISOString(),
        }
      : null,
  };
}

function applyTrackingSync(order, sync, now = new Date()) {
  let matchedItems = 0;
  let changedItems = 0;
  let existingActualShipAt = null;
  let existingCarrier = "";

  order.items = (order.items || []).map((item) => {
    const trackingInfo = item.tracking_info || {};
    if (!matchesShipmentTracking(sync.tracking, trackingInfo.tracking)) return item;
    matchedItems += 1;
    if (trackingInfo.actualShipAt && !existingActualShipAt) existingActualShipAt = trackingInfo.actualShipAt;
    if (normalize(trackingInfo.carrier) && !existingCarrier) existingCarrier = trackingInfo.carrier;

    const nextTrackingInfo = { ...trackingInfo };
    if (sync.carrier && !normalize(trackingInfo.carrier)) nextTrackingInfo.carrier = sync.carrier;
    if (sync.actualShipAt && !trackingInfo.actualShipAt) {
      nextTrackingInfo.actualShipAt = sync.actualShipAt;
      nextTrackingInfo.shipEvidence = sync.shipEvidence;
    }
    const itemChanged = JSON.stringify(nextTrackingInfo) !== JSON.stringify(trackingInfo);
    if (itemChanged) {
      nextTrackingInfo.updated_at = now;
      changedItems += 1;
    }
    return { ...item, tracking_info: nextTrackingInfo };
  });

  let submissionChanged = false;
  if (matchedItems) {
    order.vendor_submissions = order.vendor_submissions || {};
    const previous = order.vendor_submissions.viettelpost || {};
    const actualShipAt = existingActualShipAt || sync.actualShipAt || null;
    const carrier = existingCarrier || sync.carrier;
    const next = {
      ...previous,
      external_id: sync.shipmentId,
      shipment_code: sync.shipmentCode,
      tracking: sync.tracking,
      carrier,
      actual_ship_at: actualShipAt,
    };
    submissionChanged = JSON.stringify(next) !== JSON.stringify(previous);
    if (submissionChanged) order.vendor_submissions.viettelpost = { ...next, synced_at: now };
  }

  return { changedItems, matchedItems, changed: changedItems > 0 || submissionChanged };
}

module.exports = {
  buildTrackingSync,
  matchesShipmentTracking,
  applyTrackingSync,
  trackingLookupValues,
  recentShipments,
};
