const db = require("../models");
const logger = require("../helper/logger");

const blockedMetadataKeys = new Set([
  "rawOrder",
  "rawPayload",
  "rawData",
  "file",
  "files",
  "image",
  "imageUrl",
  "baseImage",
  "customFiles",
]);

function sanitizeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !blockedMetadataKeys.has(key))
  );
}

async function logOrderLifecycleEvent(payload = {}) {
  try {
    const event = {
      platform: payload.platform,
      orderId: payload.orderId,
      orderObjectId: payload.orderObjectId || null,
      shopId: payload.shopId || null,
      stage: payload.stage,
      eventType: payload.eventType,
      status: payload.status,
      actorType: payload.actorType || "system",
      actorId: payload.actorId || null,
      actorName: payload.actorName || "",
      entityType: payload.entityType || "order",
      entityId: payload.entityId || "",
      message: payload.message || "",
      reason: payload.reason || "",
      metadata: sanitizeMetadata(payload.metadata),
      occurredAt: payload.occurredAt || new Date(),
    };
    await db.OrderLifecycleEvent.create(event);
    return event;
  } catch (err) {
    logger.warn(`Order lifecycle event write failed: ${err.message}`);
    return null;
  }
}

module.exports = { logOrderLifecycleEvent, sanitizeMetadata };
