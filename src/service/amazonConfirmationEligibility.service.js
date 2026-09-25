function normalizeField(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/^"+|"+$/g, "").replace(/,+$/g, "");
}

function carrierFromTrackingInfo(info = {}) {
  const carrier = normalizeField(info.carrier);
  if (carrier) return carrier;

  const legacyCarrier = normalizeField(info.note)
    .split("|")
    .map(normalizeField)
    .reverse()
    .find((part) => /^carrier:/i.test(part));
  return legacyCarrier ? normalizeField(legacyCarrier.replace(/^carrier:/i, "")) : "";
}

function amazonUsDate(value = new Date()) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function isCancelled(value) {
  return ["canceled", "cancelled", "refund"].includes(normalizeField(value).toLowerCase());
}

function isValidTracking(value) {
  const tracking = normalizeField(value);
  return Boolean(tracking) && !/^-+$/.test(tracking);
}

function evaluateAmazonConfirmationEligibility({ order = {}, now = new Date() } = {}) {
  const reasons = new Set();
  const nowDate = now instanceof Date ? now : new Date(now);
  const items = (order.items || []).filter((item) => !isCancelled(item?.status) && !isCancelled(item?.tracking_info?.status));

  if (isCancelled(order.status)) reasons.add("ORDER_NOT_ELIGIBLE");
  if (order.buyerRequestedCancellation) reasons.add("BUYER_CANCELLATION");
  if (!items.length) reasons.add("ORDER_NOT_ELIGIBLE");

  const shipments = items.map((item) => {
    const tracking = normalizeField(item?.tracking_info?.tracking);
    const carrier = carrierFromTrackingInfo(item?.tracking_info);
    const actualShipAt = item?.tracking_info?.actualShipAt ? new Date(item.tracking_info.actualShipAt) : null;
    return { tracking, carrier, actualShipAt };
  });

  if (shipments.some(({ tracking }) => !tracking)) reasons.add("MISSING_TRACKING");
  if (shipments.some(({ tracking }) => tracking && !isValidTracking(tracking))) reasons.add("INVALID_TRACKING");
  if (shipments.some(({ carrier }) => !carrier)) reasons.add("MISSING_CARRIER");

  const trackings = [...new Set(shipments.map(({ tracking }) => tracking).filter(isValidTracking))];
  const carriers = [...new Set(shipments.map(({ carrier }) => carrier.toLowerCase()).filter(Boolean))];
  if (shipments.length > 1 && (trackings.length !== 1 || carriers.length !== 1)) reasons.add("SPLIT_OR_UNTRACKED_ITEM");

  const actualShipAt = shipments[0]?.actualShipAt || null;
  if (!actualShipAt || Number.isNaN(actualShipAt.getTime())) {
    reasons.add("MISSING_ACTUAL_SHIP_DATE");
  } else if (!Number.isNaN(nowDate.getTime()) && actualShipAt > nowDate) {
    reasons.add("FUTURE_ACTUAL_SHIP_DATE");
  }

  const shipDate = actualShipAt && !Number.isNaN(actualShipAt.getTime()) ? amazonUsDate(actualShipAt) : null;
  const shipByDate = amazonUsDate(order.shipByDate);
  if (!shipByDate) {
    reasons.add("MISSING_SHIP_BY");
  } else if (shipDate && shipDate > shipByDate) {
    reasons.add("SHIP_DATE_AFTER_SHIP_BY");
  }

  if (order.amazonConfirmation?.state) reasons.add("AMAZON_CONFIRMATION_EXISTS");

  return {
    readyForReview: reasons.size === 0,
    reasons: [...reasons],
    shipDate,
    actualShipAt,
    tracking: trackings.length === 1 ? trackings[0] : "",
    carrier: shipments[0]?.carrier || "",
  };
}

module.exports = {
  amazonUsDate,
  carrierFromTrackingInfo,
  evaluateAmazonConfirmationEligibility,
  isValidTracking,
  normalizeField,
};
