const db = require("../models");
const RealtimeLog = db.RealtimeLog;
const Shop = db.shop;
const { Types } = require("mongoose");

/**
 * Ghi 1 log
 */
async function createExtLog({
  shopId,
  machineId,
  label,
  action, // 'click' | 'auto'
  type = "import_order",
  level = "info", // 'info' | 'warn' | 'error'
  message,
  jobId,
  ts,
  meta,
}) {
  const doc = await RealtimeLog.create({
    shopId: Types.ObjectId.isValid(shopId)
      ? new Types.ObjectId(shopId)
      : shopId,
    machineId: machineId || null,
    label: label || null,
    action,
    type,
    level,
    message,
    jobId: jobId || null,
    ts: ts ? new Date(ts) : new Date(),
    meta: meta || undefined,
  });
  return doc;
}

/**
 * Ghi nhiều log (tiện khi bạn batch từ extension)
 */
async function createExtLogsBulk(logs = []) {
  if (!Array.isArray(logs) || !logs.length) return { inserted: 0 };
  const ops = logs.map((l) => ({
    insertOne: {
      document: {
        ...l,
        shopId: Types.ObjectId.isValid(l.shopId)
          ? new Types.ObjectId(l.shopId)
          : l.shopId,
        ts: l.ts ? new Date(l.ts) : new Date(),
      },
    },
  }));
  const result = await RealtimeLog.bulkWrite(ops, { ordered: false });
  return { inserted: result.insertedCount || 0 };
}

/**
 * Truy vấn log cho FE
 */
async function queryExtLogs({
  shopId,
  machineId,
  action, // optional: 'click' | 'auto'
  type, // optional: 'import_order' ...
  level, // optional
  jobId, // optional: gom theo job
  from, // epoch ms | ISO
  to, // epoch ms | ISO
  limit = 200, // default 200
  cursorTs, // optional: paginate theo ts (ms)
  sort = "desc", // 'desc' (mặc định) hoặc 'asc'
}) {
  const q = {};
  if (shopId) q.shopId = shopId;
  if (machineId) q.machineId = machineId;
  if (action) q.action = action;
  if (type) q.type = type;
  if (level) q.level = level;
  if (jobId) q.jobId = jobId;

  // time range
  const tsRange = {};
  if (from) tsRange.$gte = new Date(from);
  if (to) tsRange.$lte = new Date(to);
  if (Object.keys(tsRange).length) q.ts = tsRange;

  // cursor (keyset pagination)
  if (cursorTs) {
    const op = sort === "asc" ? "$gt" : "$lt";
    q.ts = q.ts || {};
    q.ts[op] = new Date(Number(cursorTs));
  }

  const docs = await RealtimeLog.find(q)
    .sort({ ts: sort === "asc" ? 1 : -1 })
    .limit(Math.min(500, Number(limit || 200)))
    .lean();

  return { items: docs };
}

module.exports = { createExtLog, createExtLogsBulk, queryExtLogs };
