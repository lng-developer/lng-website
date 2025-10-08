const db = require("../models");
const RealtimeLog = db.RealtimeLog;

const getLogs = async (req, res) => {
  try {
    const {
      day,
      from,
      to,
      clientId,
      jobId,
      phase,
      status,
      type = "STATUS",
      limit = 500,
      sort = "asc",
    } = req.query;

    const q = {};
    if (type) q.type = type;
    if (day) q.day = day;
    if (from || to) {
      q.ts = {};
      if (from) q.ts.$gte = Number(from);
      if (to) q.ts.$lte = Number(to);
    }
    if (clientId) q.$or = [{ clientId }, { label: clientId }];
    if (jobId) q.jobId = jobId;
    if (phase) q.phase = phase;
    if (status) q.status = status;

    const docs = await RealtimeLog.find(q)
      .sort({ ts: sort === "desc" ? -1 : 1 })
      .limit(Math.min(Number(limit) || 500, 5000))
      .lean();

    res.json({ ok: true, count: docs.length, items: docs });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = { getLogs };
