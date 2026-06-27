function pickActorName(user = {}) {
  return user.name || user.fullName || user.full_name || user.username || user.email || "";
}

function pickActorId(user = {}) {
  return user._id || user.id || user.userId || user.uid || null;
}

function pickId(value) {
  return value && typeof value === "object" ? value._id || null : value || null;
}

function buildOrderLifecyclePayload({
  order,
  req,
  fallbackPlatform,
  actorType,
  stage,
  eventType,
  status,
  message = "",
  reason = "",
  metadata = {},
  entityType = "order",
  entityId,
}) {
  const user = req?.user || {};
  const orderId = order?.orderId || order?.receiptId || "";
  return {
    platform: String(order?.platform || fallbackPlatform || "").toLowerCase(),
    orderId,
    orderObjectId: order?._id || null,
    shopId: pickId(order?.shopId),
    stage,
    eventType,
    status,
    actorType: actorType || (req?.user ? "user" : "system"),
    actorId: pickActorId(user),
    actorName: pickActorName(user),
    entityType,
    entityId: entityId || orderId,
    message,
    reason,
    metadata,
  };
}

module.exports = { buildOrderLifecyclePayload };
