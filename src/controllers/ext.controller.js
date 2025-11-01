const db = require("../models");
const Shop = db.shop;
const RealtimeLog = db.RealtimeLog;

// Hàm xử lý request chính (fire-and-forget)
const makeJobId = () =>
  "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

async function requestExtension(req, res) {
  try {
    const { shopId, machineId, type, payload } = req.body || {};
    if (!shopId || !machineId || !type) {
      return res
        .status(400)
        .json({ ok: false, message: "shopId, machineId, type required" });
    }

    const io = req.app.get("io");
    const presence = req.app.get("presence");

    const client =
      presence.getByMachine?.(machineId) ||
      presence.findBy?.({ shopId, machineId });
    const socketId = client?.socketId;

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task = { jobId, type, payload: payload || {} };

    if (socketId && io.sockets.sockets.get(socketId)) {
      io.to(socketId).emit("server:task", task);
    } else {
      // fallback theo room (Extension join machine:<id>)
      io.to(`machine:${machineId}`).emit("server:task", task);
    }

    // TRẢ LUÔN — không đợi ACK
    return res.json({ ok: true, jobId, delivered: true });
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
