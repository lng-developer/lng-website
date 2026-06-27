const db = require("../models");

const MAX_LIMIT = 200;
const MAX_PAGE = 50;
const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildFilter(query = {}, { defaultLast24h = false } = {}) {
  const filter = {};
  for (const key of ["platform", "orderId", "shopId", "stage", "status", "eventType"]) {
    if (query[key]) filter[key] = query[key];
  }

  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  const occurredAt = {};
  if (from && !Number.isNaN(from.getTime())) occurredAt.$gte = from;
  if (to && !Number.isNaN(to.getTime())) occurredAt.$lte = to;
  if (!Object.keys(occurredAt).length && defaultLast24h) {
    occurredAt.$gte = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }
  if (Object.keys(occurredAt).length) filter.occurredAt = occurredAt;

  return filter;
}

function validateQuery(query = {}) {
  if (query.page && parsePositiveInt(query.page, 1) > MAX_PAGE) {
    return "Order lifecycle page is too deep; narrow filters or use page <= 50";
  }

  if (!query.orderId && query.from && query.to) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to - from > MAX_RANGE_MS) {
      return "Order lifecycle date range cannot exceed 30 days without orderId";
    }
  }

  return null;
}

async function getEvents(req, res) {
  try {
    const queryError = validateQuery(req.query);
    if (queryError) return res.status(400).json({ message: queryError });

    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(MAX_LIMIT, parsePositiveInt(req.query.limit, 50));
    const skip = (page - 1) * limit;
    const filter = buildFilter(req.query);

    const [total, data] = await Promise.all([
      db.OrderLifecycleEvent.countDocuments(filter),
      db.OrderLifecycleEvent.find(filter)
        .sort({ occurredAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    return res.json({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to get order lifecycle events", error: err.message });
  }
}

async function getSummary(req, res) {
  try {
    const queryError = validateQuery(req.query);
    if (queryError) return res.status(400).json({ message: queryError });

    const baseFilter = buildFilter(req.query, { defaultLast24h: true });
    const [totalsRows, stageRows, eventTypeRows, recentFailures] = await Promise.all([
      db.OrderLifecycleEvent.aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
            success: { $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] } },
            warning: { $sum: { $cond: [{ $eq: ["$status", "warning"] }, 1, 0] } },
          },
        },
      ]),
      db.OrderLifecycleEvent.aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: "$stage",
            total: { $sum: 1 },
            failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          },
        },
        { $sort: { failed: -1, total: -1 } },
      ]),
      db.OrderLifecycleEvent.aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: "$eventType",
            total: { $sum: 1 },
            failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          },
        },
        { $sort: { failed: -1, total: -1 } },
      ]),
      db.OrderLifecycleEvent.find({ ...baseFilter, status: "failed" })
        .sort({ occurredAt: -1 })
        .limit(10)
        .lean(),
    ]);

    const totals = totalsRows[0] || { total: 0, failed: 0, success: 0, warning: 0 };
    return res.json({
      totals: {
        total: totals.total || 0,
        failed: totals.failed || 0,
        success: totals.success || 0,
        warning: totals.warning || 0,
      },
      byStage: stageRows.map((row) => ({ stage: row._id, total: row.total, failed: row.failed })),
      byEventType: eventTypeRows.map((row) => ({ eventType: row._id, total: row.total, failed: row.failed })),
      recentFailures: recentFailures.map((event) => ({
        orderId: event.orderId,
        platform: event.platform,
        stage: event.stage,
        eventType: event.eventType,
        reason: event.reason,
        occurredAt: event.occurredAt,
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to get order lifecycle summary", error: err.message });
  }
}

module.exports = { getEvents, getSummary, _buildFilter: buildFilter, _validateQuery: validateQuery };
