const mongoose = require("mongoose");
const EtsyMessageThread = require("../models/etsyMessageThread.model");

function toDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFingerprint(message = {}) {
  return [
    String(message.threadId || ""),
    String(message.latestMessagePreview || message.latestMessageBody || ""),
  ].join("|");
}

function assertValidShopId(shopId) {
  if (!mongoose.Types.ObjectId.isValid(String(shopId || ""))) {
    throw new Error("Invalid shopId");
  }
}

function buildThreadUpdate({ payload, message, shopId, syncedAt, fingerprint, lastMessageAt, eventItem }) {
  const set = {
    shopId,
    machineId: String(payload.machineId || ""),
    threadId: String(message.threadId || "").trim(),
    buyerName: String(message.buyerName || ""),
    buyerUsername: String(message.buyerUsername || ""),
    orderId: String(message.orderId || ""),
    unread: message.unread === true,
    latestMessageBody: String(message.latestMessageBody || ""),
    latestMessagePreview: String(message.latestMessagePreview || ""),
    sourceUrl: String(message.sourceUrl || ""),
    lastMessageAt,
    lastSyncedAt: syncedAt,
    lastEventId: String(payload.eventId || ""),
    fingerprint,
    rawLastPayload: message,
  };

  if (message.unread === true) {
    set.status = "open";
  }

  return {
    $set: set,
    $push: {
      events: {
        $each: [eventItem],
        $slice: -20,
      },
    },
    $setOnInsert: {
      createdAt: new Date(),
    },
  };
}

async function upsertOneThread({ payload, message, shopId, syncedAt }) {
  const threadId = String(message.threadId || "").trim();
  if (!threadId) return null;

  const fingerprint = String(message.fingerprint || buildFingerprint(message));
  const lastMessageAt = toDateOrNull(message.lastMessageAt);
  const eventItem = {
    eventId: String(payload.eventId || ""),
    reason: String(message.reason || ""),
    latestMessageBody: String(message.latestMessageBody || ""),
    latestMessagePreview: String(message.latestMessagePreview || ""),
    lastMessageAt,
    receivedAt: new Date(),
    raw: message,
  };

  const filter = { shopId, threadId };
  const update = buildThreadUpdate({
    payload,
    message,
    shopId,
    syncedAt,
    fingerprint,
    lastMessageAt,
    eventItem,
  });

  try {
    return await EtsyMessageThread.findOneAndUpdate(filter, update, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }).lean();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return EtsyMessageThread.findOneAndUpdate(filter, update, { new: true }).lean();
  }
}

async function upsertEtsyMessageThreads(payload = {}) {
  const shopId = String(payload.shopId || payload.machineId || "").trim();
  assertValidShopId(shopId);

  const messages = Array.isArray(payload?.result?.messages)
    ? payload.result.messages
    : [];
  const syncedAt = toDateOrNull(payload?.result?.syncedAt) || new Date();

  const saved = [];
  const errors = [];

  for (const message of messages) {
    try {
      const doc = await upsertOneThread({ payload, message, shopId, syncedAt });
      if (doc) saved.push(doc);
    } catch (err) {
      errors.push({
        threadId: String(message?.threadId || ""),
        message: err.message || String(err),
      });
    }
  }

  return {
    ok: errors.length === 0,
    received: messages.length,
    saved: saved.length,
    failed: errors.length,
    errors,
    items: saved,
  };
}

async function listEtsyMessageThreads(params = {}) {
  const shopId = String(params.shopId || "").trim();
  assertValidShopId(shopId);

  const page = Math.max(1, Number(params.page || 1));
  const limit = Math.max(1, Math.min(Number(params.limit || 50), 100));
  const status = String(params.status || "").trim();
  const unread = params.unread;
  const q = String(params.q || "").trim();
  const filter = { shopId };

  if (status) filter.status = status;
  if (unread === "true" || unread === true) filter.unread = true;
  if (unread === "false" || unread === false) filter.unread = false;

  if (q) {
    const rx = new RegExp(escapeRegExp(q), "i");
    filter.$or = [
      { buyerName: rx },
      { buyerUsername: rx },
      { orderId: rx },
      { latestMessagePreview: rx },
      { latestMessageBody: rx },
    ];
  }

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    EtsyMessageThread.find(filter)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    EtsyMessageThread.countDocuments(filter),
  ]);

  return {
    ok: true,
    items,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

async function getEtsyMessageThread({ shopId, threadId }) {
  assertValidShopId(shopId);

  const doc = await EtsyMessageThread.findOne({
    shopId,
    threadId: String(threadId || "").trim(),
  }).lean();

  if (!doc) {
    return {
      ok: false,
      notFound: true,
      message: "Etsy message thread not found",
    };
  }

  return { ok: true, item: doc };
}

async function markEtsyMessageThreadRead({ shopId, threadId, unread = false }) {
  assertValidShopId(shopId);

  const isUnread = unread === true;
  const doc = await EtsyMessageThread.findOneAndUpdate(
    {
      shopId,
      threadId: String(threadId || "").trim(),
    },
    {
      $set: {
        unread: isUnread,
        status: isUnread ? "open" : "read",
      },
    },
    { new: true }
  ).lean();

  if (!doc) {
    return {
      ok: false,
      notFound: true,
      message: "Etsy message thread not found",
    };
  }

  return { ok: true, item: doc };
}

module.exports = {
  upsertEtsyMessageThreads,
  listEtsyMessageThreads,
  getEtsyMessageThread,
  markEtsyMessageThreadRead,
};
