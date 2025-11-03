const db = require("../models");
const Shop = db.shop;
const RealtimeLog = db.RealtimeLog;

async function requestExtension(req, res) {
  try {
    const {
      shopId,
      machineId,
      action = "click",
      label = null,
    } = req.body || {};
    if (!shopId || !machineId) {
      return res
        .status(400)
        .json({ ok: false, message: "shopId & machineId required" });
    }

    const io = req.app.get("io");
    if (!io) return res.status(500).json({ ok: false, message: "io missing" });

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task = { jobId, type: "IMPORT_ORDERS", payload: {} };

    // Phát theo ROOM (extension đã join: shop:..., machine:...)
    io.to(`machine:${machineId}`).emit("server:task", task);

    // Ghi 1 log “start import requested”
    await RealtimeLog.create({
      shopId,
      machineId,
      label,
      action, // 'click' | 'auto'
      level: "info",
      message: `Start import requested → jobId=${jobId}`,
      ts: new Date(),
    });

    return res.json({ ok: true, jobId });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

// GET /api/ext/clients/online
const getClientOnline = async (req, res) => {
  const presence = req.app.get("presence");
  if (!presence) return res.json({ ok: true, clients: [] });

  const { shopId } = req.query || {};
  let list = presence.snapshot(); // [{shopId, machineId, label, status, lastSeen, ua, ip, socketId, version}, ...]

  if (shopId) list = list.filter((c) => String(c.shopId) === String(shopId));
  // chỉ trả online (tùy nhu cầu)
  list = list.filter((c) => c.status === "online");

  return res.json({ ok: true, clients: list });
};

module.exports = {
  requestExtension,
  getClientOnline,
};
