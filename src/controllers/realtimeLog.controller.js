const db = require("../models");
const RealtimeLog = db.RealtimeLog;
const Shop = db.shop;
const { Types } = require("mongoose");

// helper
async function writeLog({
  shopId,
  machineId,
  label = null,
  action = "click",
  level = "info",
  message,
}) {
  return RealtimeLog.create({
    shopId,
    machineId,
    label,
    action,
    level,
    message,
    ts: new Date(),
  });
}

/**
 * POST /api/logs/add
 * body: { shopId, machineId, label, action, level, message }
 * -> thêm 1 dòng log
 */
async function addLog(req, res) {
  try {
    const {
      shopId,
      machineId,
      label,
      action = "click",
      level = "info",
      message,
    } = req.body || {};
    if (!shopId || !machineId || !message) {
      return res
        .status(400)
        .json({ ok: false, message: "shopId, machineId, message required" });
    }
    const row = await writeLog({
      shopId,
      machineId,
      label,
      action,
      level,
      message,
    });
    return res.json({ ok: true, logId: row._id });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

const appendLogs = async (req, res) => {
  try {
    const {
      shopId,
      machineId,
      label,
      action = "click",
      lines,
    } = req.body || {};
    if (!shopId || !machineId || !Array.isArray(lines) || !lines.length) {
      return res
        .status(400)
        .json({ ok: false, message: "shopId, machineId, lines[] required" });
    }
    const docs = lines
      .filter((l) => l && l.message)
      .map((l) => ({
        shopId,
        machineId,
        label: label || null,
        action,
        level: l.level || "info",
        message: String(l.message),
        ts: l.at ? new Date(l.at) : new Date(),
      }));
    if (!docs.length) return res.json({ ok: true, inserted: 0 });
    await RealtimeLog.insertMany(docs, { ordered: false });
    return res.json({ ok: true, inserted: docs.length });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};

const getListLog = async (req, res) => {
  try {
    const { machineId, limit = "500", tzOffset } = req.query || {};

    // Tính mốc "đầu ngày" và "hiện tại"
    const now = new Date();
    let start, end;

    if (tzOffset !== undefined) {
      // dịch sang múi giờ người dùng, set 00:00:00, rồi dịch ngược về UTC
      const offsetMin = parseInt(tzOffset, 10) || 0; // phút
      const nowShifted = new Date(now.getTime() + offsetMin * 60000);
      const startShifted = new Date(nowShifted);
      startShifted.setHours(0, 0, 0, 0);
      start = new Date(startShifted.getTime() - offsetMin * 60000);
      end = now; // tới hiện tại (UTC)
    } else {
      // theo giờ server
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      end = now;
    }

    const where = { ts: { $gte: start, $lte: end } };
    if (machineId) where.machineId = String(machineId);

    const rows = await RealtimeLog.find(where)
      .limit(Math.min(Number(limit) || 500, 1000))
      .lean();

    const logs = rows.map((r) => ({
      at: +new Date(r.ts),
      shopId: String(r.shopId),
      machineId: r.machineId,
      label: r.label || null,
      action: r.action,
      level: r.level,
      message: r.message,
    }));

    return res.json({ ok: true, logs });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = { addLog, getListLog, appendLogs };
