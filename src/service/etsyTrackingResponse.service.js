const {
  cleanTrackingString,
  normalizeProviderKey,
  normalizeVendorSubmissionTracking,
  parseCarrierFromNote,
} = require("./vendorTrackingNormalizer.service");

const getVendorSubmissions = (order) => {
  const submissions = order?.vendor_submissions || {};
  return Object.entries(submissions).filter(([, submission]) => submission && typeof submission === "object");
};

const getItemProviderKey = (item = {}) => {
  const trackingInfo = item.tracking_info || {};
  return normalizeProviderKey(
    trackingInfo.fulfillment ||
      item.fulfillment ||
      item.vendor ||
      item.vendor_key ||
      item.vendorKey ||
      item.cost_breakdown?.vendor ||
      item.cost_breakdown?.vendor_key ||
      item.cost_breakdown?.vendorKey
  );
};

const getBestSubmissionTracking = (order, item = {}) => {
  const submissions = getVendorSubmissions(order);
  const itemProvider = getItemProviderKey(item);
  const normalized = submissions.map(([provider, submission]) =>
    normalizeVendorSubmissionTracking(provider, submission)
  );

  const matched = itemProvider
    ? normalized.find((tracking) => tracking.provider === itemProvider)
    : null;
  if (matched) return matched;

  return (
    normalized.find((tracking) => tracking.trackingNumber) ||
    normalized.find((tracking) => tracking.carrier || tracking.status || tracking.externalOrderId) ||
    {}
  );
};

const buildEtsyTrackingSummary = (order, item = {}) => {
  const ti = item.tracking_info || {};
  const providerTracking = getBestSubmissionTracking(order, item);
  const fulfillment = cleanTrackingString(ti.fulfillment || providerTracking.fulfillment);
  const provider = normalizeProviderKey(providerTracking.provider || fulfillment);
  const trackingNumber = cleanTrackingString(ti.tracking) || providerTracking.trackingNumber || "";
  const carrier = parseCarrierFromNote(ti.note) || providerTracking.carrier || "";
  const status = cleanTrackingString(ti.status) || providerTracking.status || providerTracking.vendorStatus || "";

  return {
    vendor: provider,
    fulfillment,
    status,
    trackingNumber,
    carrier,
    trackingUrl: providerTracking.trackingUrl || "",
    shippingLabel: providerTracking.shippingLabel || "",
    vendorStatus: providerTracking.vendorStatus || "",
    externalOrderId: providerTracking.externalOrderId || "",
    shipmentId: providerTracking.shipmentId || "",
    productionAt: providerTracking.productionAt || null,
    paidAt: providerTracking.paidAt || null,
    updatedAt: ti.updated_at || providerTracking.updatedAt || null,
  };
};

const buildEtsyTrackingInfoResponse = (order, item = {}) => {
  const ti = item.tracking_info || {};
  const summary = buildEtsyTrackingSummary(order, item);
  return {
    ...ti,
    fulfillment: cleanTrackingString(ti.fulfillment) || summary.fulfillment,
    tracking: cleanTrackingString(ti.tracking) || summary.trackingNumber,
    status: cleanTrackingString(ti.status) || summary.status,
    note: ti.note || (summary.carrier ? `carrier:${summary.carrier}` : ""),
    updated_at: ti.updated_at || summary.updatedAt || undefined,
  };
};

module.exports = {
  buildEtsyTrackingInfoResponse,
  buildEtsyTrackingSummary,
  cleanTrackingString,
};
