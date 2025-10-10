const db = require("../models");
const RealtimeLog = db.RealtimeLog;
const Shop = db.shop;

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

const addLog = async (req, res) => {
  try {
    const { shopId, clientId, label, phase, status, ms, error } =
      req.body || {};
    if (!phase || !status) {
      return res
        .status(400)
        .json({ ok: false, message: "phase & status required" });
    }

    const ts = Date.now();
    await RealtimeLog.create({
      ts,
      type: "STATUS",
      day: new Date(ts).toISOString().slice(0, 10),
      clientId: clientId || null,
      label: label || null,
      phase,
      status,
      ms: Number.isFinite(ms) ? ms : undefined,
      error: error || undefined,
      meta: { shopId: shopId || null },
    });

    // Nếu là CONNECTED client trong Shop → cập nhật lastSeen + trạng thái
    if (clientId && shopId) {
      await Shop.updateOne(
        { store: shopId, "clients.clientId": clientId },
        {
          $set: {
            "clients.$.lastSeen": new Date(),
            "clients.$.status": "online",
          },
        }
      ).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /ext/log error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = { getLogs, addLog };
