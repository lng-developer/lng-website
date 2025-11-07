const db = require("../models");
const Shop = db.shop;
const RealtimeLog = db.RealtimeLog;

const pullAllOrder = async (req, res) => {
  const { action = "click", label = null, type, payload } = req.body || {};

  const io = req.app.get("io");
  if (!io) return res.status(500).json({ ok: false, message: "io missing" });

  const task = { type: type, payload: payload };

  // 🔊 gửi cho mọi socket trong namespace mặc định
  io.emit("server:task", task);

  // Ước lượng số socket nhận được (nếu cần)
  const recipients = io.of("/").sockets.size || 0;

  await RealtimeLog.create({
    label: "All Clients",
    action,
    level: "info",
    message: `Start import orders for ${recipients} client...`,
    ts: new Date(),
  });

  return res.status(202).json({
    ok: true,
    recipients,
    message: "Broadcast IMPORT_ORDERS to all connected extensions",
  });
};

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

const getClientOnline = async (req, res) => {
  try {
    const presence = req.app.get("presence");
    const io = req.app.get("io");
    if (!io || !presence) return res.json({ ok: true, clients: [] });

    const {
      shopId: filterShopId,
      machineId: filterMachineId,
      q,
    } = req.query || {};
    const now = Date.now();
    const TTL_MS = Number(process.env.PRESENCE_TTL_MS || 45000); // tuỳ bạn set

    // 1) Live socket IDs đang kết nối (namespace mặc định '/')
    const liveSocketIds = new Set(io.of("/").sockets.keys());

    // 2) Presence snapshot (đã lọc TTL)
    const snap = presence.snapshot() || []; // [{machineId, shopId, label, version, ua, ip, lastSeen, socketId, ...}]

    // 3) Giữ record mới nhất cho mỗi machineId (nếu presence còn dư)
    const latestByMachine = new Map();
    for (const c of snap) {
      if (!c?.machineId) continue;
      if (filterShopId && String(c.shopId) !== String(filterShopId)) continue;
      if (filterMachineId && String(c.machineId) !== String(filterMachineId))
        continue;

      const prev = latestByMachine.get(String(c.machineId));
      if (!prev || (c.lastSeen || 0) > (prev.lastSeen || 0)) {
        latestByMachine.set(String(c.machineId), c);
      }
    }

    // 4) Xác thực "online thật" bằng live sockets:
    //    - Nếu socketId cũ không còn, thử lấy từ room "machine:<machineId>"
    const roomMap = io.of("/").adapter.rooms;
    const candidates = [];
    for (const c of latestByMachine.values()) {
      let sid = c.socketId && liveSocketIds.has(c.socketId) ? c.socketId : null;

      if (!sid && roomMap) {
        const room = roomMap.get(`machine:${c.machineId}`);
        if (room && room.size) {
          for (const anySid of room) {
            if (liveSocketIds.has(anySid)) {
              sid = anySid;
              break;
            }
          }
        }
      }

      if (!sid) continue; // không còn socket sống → bỏ

      // filter theo q (nếu có)
      if (q) {
        const hay = `${c.label || ""} ${c.ua || ""}`.toLowerCase();
        if (!hay.includes(String(q).toLowerCase())) continue;
      }

      candidates.push({ ...c, socketId: sid });
    }

    if (!candidates.length) return res.json({ ok: true, clients: [] });

    // 5) Load info Shop cho đẹp (name/store)
    const uniqueShopIds = [
      ...new Set(candidates.map((c) => String(c.shopId)).filter(Boolean)),
    ];
    const shops = await Shop.find(
      { _id: { $in: uniqueShopIds } },
      { _id: 1, name: 1, store: 1 }
    ).lean();
    const shopMap = new Map(shops.map((s) => [String(s._id), s]));

    // 6) Map output chuẩn FE
    const out = candidates.map((c) => {
      const shop = shopMap.get(String(c.shopId));
      const lastSeenMs = c.lastSeen || now;
      const staleMs = now - lastSeenMs;
      const stale = staleMs > TTL_MS; // hiếm khi xảy ra vì presence.snapshot đã lọc, nhưng để sẵn

      return {
        // keys cũ để tương thích
        socketId: c.socketId || null,
        clientId: c.machineId || null,

        // hiển thị
        machineId: c.machineId || null,
        label: c.label || shop?.name || shop?.store || `Client ${c.machineId}`,
        version: c.version || "",
        ua: c.ua || "",
        ip: c.ip || "",

        // shop
        shopId: String(c.shopId || ""),
        shopName: shop?.name || shop?.store || String(c.shopId || ""),

        // ổn định
        id: `${String(c.shopId)}:${String(c.machineId)}`,

        // thời gian
        connectedAt: lastSeenMs, // presence không lưu firstSeen → dùng lastSeen
        lastSeen: lastSeenMs,

        // trạng thái
        status: stale ? "maybe-online" : "online",
        statusSummary: {
          overall: stale ? "warning" : "success",
          lastTs: lastSeenMs,
          // hai trường dưới chỉ minh hoạ (tuỳ bạn muốn tính)
          onlineForSec: 0,
          idleForSec: Math.max(0, Math.floor(staleMs / 1000)),
        },
      };
    });

    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = {
  requestExtension,
  getClientOnline,
  pullAllOrder,
};
