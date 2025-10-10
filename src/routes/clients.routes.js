const router = require("express").Router();
const { buildPhaseSnapshotFromDB } = require("../service/realtime.service");
const { getOnlineClients } = require("../socket");

router.get("/", async (req, res) => {
  try {
    const onlyExt = String(req.query.onlyExt || "0") === "1";
    const snapshot = await buildPhaseSnapshotFromDB();
    const now = Date.now();

    let actives = [...getOnlineClients().values()].map((c) => {
      const key = c.clientId || c.label || c.socketId;
      const sum = snapshot[key] || {};
      return {
        socketId: c.socketId,
        clientId: c.clientId,
        label: c.label,
        version: c.version,
        ua: c.ua,
        ip: c.ip,
        connectedAt: c.connectedAt,
        lastSeen: c.lastSeen,
        statusSummary: {
          overall: sum.overall || "idle",
          lastJobId: sum.lastJobId,
          lastTs: sum.lastTs || 0,
          phases: sum.phases || {},
          onlineForSec: Math.round((now - c.connectedAt) / 1000),
          idleForSec: Math.round((now - (c.lastSeen || c.connectedAt)) / 1000),
        },
      };
    });

    if (onlyExt) {
      actives = actives.filter(
        (c) =>
          (c.clientId && c.clientId.trim() !== "") ||
          (c.version && String(c.version).startsWith("ext-")) ||
          (c.label && String(c.label).startsWith("Machine-"))
      );
    }

    actives.sort(
      (a, b) => (b.statusSummary.lastTs || 0) - (a.statusSummary.lastTs || 0)
    );
    res.json(actives);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
