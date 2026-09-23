function isRealTracking(value) {
  const tracking = String(value || "").trim();
  return Boolean(tracking && tracking !== "-" && tracking !== "---");
}

function resolveTrackingReceivedAt(existing, previousTracking, nextTracking, now = new Date()) {
  if (existing) return existing;
  return !isRealTracking(previousTracking) && isRealTracking(nextTracking) ? now : null;
}

module.exports = { resolveTrackingReceivedAt };
