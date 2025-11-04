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
      type,
      payload,
    } = req.body || {};
    if (!shopId || !machineId) {
      return res
        .status(400)
        .json({ ok: false, message: "shopId & machineId required" });
    }

    const io = req.app.get("io");
    if (!io) return res.status(500).json({ ok: false, message: "io missing" });

    const task = { type: type, payload: payload };

    let message =
      type === "IMPORT_ORDERS"
        ? "Start import orders ..."
        : "Start import ads ...";

    io.to(`machine:${machineId}`).emit("server:task", task);

    await RealtimeLog.create({
      shopId,
      machineId,
      label,
      action,
      level: "info",
      message: message,
      ts: new Date(),
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

// GET /api/ext/clients/online
const getClientOnline = async (req, res) => {
  try {
    const presence = req.app.get("presence");
    if (!presence) return res.json([]);

    // snapshot() đã lọc theo TTL → coi như online
    const snap = presence.snapshot(); // [{machineId, shopId, label, version, ua, ip, lastSeen, socketId, ...}]
    if (!snap.length) return res.json([]);

    // Lấy thông tin shop name/store cho các shopId xuất hiện
    const uniqueShopIds = [
      ...new Set(snap.map((c) => String(c.shopId)).filter(Boolean)),
    ];

    const shops = await Shop.find(
      { _id: { $in: uniqueShopIds } },
      { _id: 1, name: 1, store: 1 }
    ).lean();

    const shopMap = new Map(shops.map((s) => [String(s._id), s]));

    const out = snap.map((c) => {
      const shop = shopMap.get(String(c.shopId));
      const lastSeenMs = c.lastSeen || Date.now();
      return {
        // tương thích FE cũ
        socketId: c.socketId || null,
        clientId: c.machineId || null,

        // thông tin hiển thị
        machineId: c.machineId || null,
        label: c.label || shop?.name || shop?.store || `Client ${c.machineId}`,
        version: c.version || "",
        ua: c.ua || "",
        ip: c.ip || "",

        // shop
        shopId: String(c.shopId || ""),
        shopName: shop?.name || shop?.store || String(c.shopId || ""),

        // key ổn định cho FE
        id: `${String(c.shopId)}:${String(c.machineId)}`,

        // thời gian
        connectedAt: lastSeenMs, // presence không giữ firstSeen → dùng lastSeen làm mốc gần nhất
        lastSeen: lastSeenMs,

        // trạng thái luôn online vì lấy từ RAM realtime
        status: "online",
        statusSummary: {
          overall: "success",
          lastJobId: null,
          lastTs: lastSeenMs,
          phases: {},
          onlineForSec: 0,
          idleForSec: 0,
        },
      };
    });

    // sort theo lastSeen giảm dần
    out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = {
  requestExtension,
  getClientOnline,
};
