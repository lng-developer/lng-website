const db = require("../models");

const VendorWebhookLog = db.VendorWebhookLog;

function norm(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function detectSignatureType(req = {}) {
  const headers = req.headers || {};
  if (headers["x-onos-hmac-sha256"]) return "onos-hmac";
  if (headers["x-webhook-token"] || headers["x-provider-webhook-token"] || headers["x-vendor-webhook-token"]) {
    return "token";
  }
  if (norm(headers.authorization).toLowerCase().startsWith("bearer ")) return "bearer";
  if (req.query?.token) return "query-token";
  return "none";
}

function buildLogDocument({ provider, req, payload, result, error, httpStatus }) {
  const event = result?.event || error?.event || {};
  const resultData = result?.result || {};
  const outcome = error
    ? "error"
    : resultData.skipped
      ? "skipped"
      : "success";

  return {
    provider: norm(provider).toLowerCase(),
    outcome,
    httpStatus,
    message: error?.message || result?.message || "",
    orderId: norm(event.orderId || resultData.orderId),
    externalId: norm(event.externalId),
    eventStatus: norm(event.status),
    tracking: norm(event.tracking || resultData.tracking),
    carrier: norm(event.carrier || resultData.carrier),
    collection: norm(resultData.collection),
    matchedItems: Number(resultData.matchedItems || 0),
    changedItems: Number(resultData.changedItems || 0),
    orderStatusChanged: !!resultData.orderStatusChanged,
    request: {
      method: norm(req?.method),
      path: norm(req?.originalUrl || req?.url),
      ip: norm(req?.ip),
      userAgent: norm(req?.headers?.["user-agent"]),
      signatureType: detectSignatureType(req),
    },
    error: error
      ? {
        name: norm(error.name),
        message: norm(error.message),
        status: error.status || httpStatus || null,
        event: error.event || null,
      }
      : undefined,
    rawPayload: payload || null,
    result: result || null,
  };
}

async function createVendorWebhookLog(input) {
  if (!VendorWebhookLog) return null;
  const doc = buildLogDocument(input);
  return VendorWebhookLog.create(doc);
}

async function safeCreateVendorWebhookLog(input) {
  try {
    return await createVendorWebhookLog(input);
  } catch (err) {
    console.error("[VENDOR_WEBHOOK_LOG_ERROR]", err.message);
    return null;
  }
}

async function listVendorWebhookLogs(query = {}) {
  const {
    provider,
    outcome,
    orderId,
    externalId,
    tracking,
    page = 1,
    perPage = 50,
  } = query;

  const filter = {};
  if (provider) filter.provider = norm(provider).toLowerCase();
  if (outcome) filter.outcome = norm(outcome).toLowerCase();
  if (orderId) filter.orderId = norm(orderId);
  if (externalId) filter.externalId = norm(externalId);
  if (tracking) filter.tracking = norm(tracking);

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(perPage, 10) || 50, 1), 200);
  const skip = (pageNum - 1) * limit;

  const [data, total] = await Promise.all([
    VendorWebhookLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    VendorWebhookLog.countDocuments(filter),
  ]);

  return {
    data,
    total,
    currentPage: pageNum,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

module.exports = {
  buildLogDocument,
  createVendorWebhookLog,
  safeCreateVendorWebhookLog,
  listVendorWebhookLogs,
};
