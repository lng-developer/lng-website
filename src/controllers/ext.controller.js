const db = require("../models");
const Shop = db.shop;
const RealtimeLog = db.RealtimeLog;
const logbus = require("../lib/logbus");

const getClients = async (_req, res) => {
  try {
    const shops = await Shop.find(
      {},
      { _id: 1, store: 1, name: 1, clients: 1 }
    ).lean();

    const out = [];
    for (const s of shops) {
      const list = Array.isArray(s.clients) ? s.clients : [];
      list.forEach((c, idx) => {
        const lastSeenMs = c?.lastSeen ? new Date(c.lastSeen).getTime() : 0;
        const firstSeenMs = c?.firstSeen ? new Date(c.firstSeen).getTime() : 0;

        out.push({
          socketId: c?.socketId || null,
          clientId: c?.clientId || c?.machineId || null,

          label: c?.label || `${s.name || s.store || s._id}`,
          version: c?.version || "",
          ua: c?.ua || "",
          ip: c?.ip || "",

          shopId: String(s._id),
          shopName: s.name || s.store || String(s._id),

          id: `${String(s._id)}:${c?.machineId || idx}`,
          connectedAt: firstSeenMs,
          lastSeen: lastSeenMs,

          status: c?.status || "offline",
          statusSummary: {
            overall: c?.status === "online" ? "success" : "idle",
            lastJobId: c?.lastJobId || null,
            lastTs: lastSeenMs,
            phases: c?.phases || {},
            onlineForSec: 0,
            idleForSec: 0,
          },

          machineId: c?.machineId || null,
        });
      });
    }

    out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

    try {
      await RealtimeLog.create({
        ts: Date.now(),
        type: "EXT_CLIENTS_LISTED",
        day: new Date().toISOString().slice(0, 10),
        clientId: null,
        label: null,
        meta: { total: out.length },
      });
    } catch {}

    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};

const connectExtension = async (req, res) => {
  try {
    const { shopId, label, version, machineId, ua } = req.body || {};
    if (!shopId)
      return res.status(400).json({ ok: false, message: "shopId required" });

    const shop = await Shop.findOne(
      { _id: shopId },
      { _id: 1, name: 1, store: 1 }
    ).lean();
    if (!shop)
      return res.status(404).json({ ok: false, message: "Shop not found" });

    const now = new Date();
    const ip =
      (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      "";

    let result = "UPDATED_BY_SHOP";

    if (machineId) {
      const upd = await Shop.updateOne(
        { _id: shopId, "clients.machineId": machineId },
        {
          $set: {
            "clients.$.lastSeen": now,
            "clients.$.status": "online",
            "clients.$.version": version || "",
            "clients.$.label":
              label || shop.name || shop.store || String(shopId),
            "clients.$.ua": ua || "",
            "clients.$.ip": ip,
            "clients.$.clientId": machineId,
          },
        }
      );

      if (!upd.modifiedCount) {
        await Shop.updateOne(
          { _id: shopId },
          {
            $push: {
              clients: {
                shopId,
                machineId,
                clientId: machineId,
                label: label || shop.name || shop.store || String(shopId),
                version: version || "",
                status: "online",
                firstSeen: now,
                lastSeen: now,
                ua: ua || "",
                ip,
                socketId: null,
              },
            },
          }
        );
        result = "CREATED_BY_MACHINE";
      } else {
        result = "UPDATED_BY_MACHINE";
      }
    } else {
      const existed = await Shop.exists({
        _id: shopId,
        "clients.shopId": shopId,
      });
      if (existed) {
        await Shop.updateOne(
          { _id: shopId, "clients.shopId": shopId },
          {
            $set: {
              "clients.$.lastSeen": now,
              "clients.$.status": "online",
              ...(version ? { "clients.$.version": version } : {}),
              ...(label ? { "clients.$.label": label } : {}),
              ...(ua ? { "clients.$.ua": ua } : {}),
              "clients.$.ip": ip,
            },
          }
        );
        result = "UPDATED_BY_SHOP";
      } else {
        await Shop.updateOne(
          { _id: shopId },
          {
            $push: {
              clients: {
                shopId,
                label: label || shop.name || shop.store || String(shopId),
                version: version || "",
                status: "online",
                firstSeen: now,
                lastSeen: now,
                ua: ua || "",
                ip,
                socketId: null,
                clientId: null,
                machineId: null,
              },
            },
          }
        );
        result = "CREATED_BY_SHOP";
      }
    }

    try {
      await RealtimeLog.create({
        ts: Date.now(),
        type: result.startsWith("CREATED")
          ? "CONNECT_CREATE"
          : "CONNECT_UPDATE",
        day: now.toISOString().slice(0, 10),
        clientId: machineId || null,
        label: label || null,
        meta: { shopId, version: version || "", ip, ua: ua || "" },
      });
    } catch {}

    res.json({ ok: true, result });
  } catch (e) {
    console.error("POST /ext/connect error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
};

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

    // tìm socketId hiện online (nếu có)
    const client =
      presence.getByMachine?.(machineId) ||
      presence.findBy?.({ shopId, machineId });
    const socketId = client?.socketId;

    const jobId = makeJobId();
    const task = { jobId, type, payload: payload || {} };

    let delivered = false;
    if (socketId && io.sockets.sockets.get(socketId)) {
      io.to(socketId).emit("server:task", task);
      delivered = true;
    } else {
      // fallback room; nếu ext đã join `machine:${machineId}`
      io.to(`machine:${machineId}`).emit("server:task", task);
      delivered = true; // coi như đã phát đi
    }

    // TRẢ NGAY – không chờ ACK, không block
    return res
      .status(202)
      .json({ ok: true, jobId, delivered, mode: "fire-and-forget" });
  } catch (e) {
    console.error("command error", e);
    return res
      .status(500)
      .json({ ok: false, message: String(e?.message || e) });
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

const getLogs = (req, res) => {
  const { shopId, machineId, since, limit } = req.query || {};
  const out = logbus.query({
    shopId,
    machineId,
    since,
    limit: Number(limit || 200),
  });
  res.json({ ok: true, logs: out });
};

const getLogsSummary = (req, res) => {
  const {
    shopId = "",
    machineId = "",
    from = 0,
    to = Date.now(),
  } = req.query || {};
  try {
    const s = logbus.summary({
      shopId: shopId || undefined,
      machineId: machineId || undefined,
      from: Number(from) || 0,
      to: Number(to) || Date.now(),
    });
    res.json({ ok: true, ...s });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};

const exportLogs = (req, res) => {
  const {
    shopId = "",
    machineId = "",
    since = 0,
    limit = 1000,
  } = req.query || {};
  const rows = logbus.query({
    shopId: shopId || undefined,
    machineId: machineId || undefined,
    since: Number(since) || 0,
    limit: Math.min(Math.max(Number(limit) || 1000, 1), 5000),
  });
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  for (const r of rows) res.write(JSON.stringify(r) + "\n");
  res.end();
};

module.exports = {
  getClients,
  connectExtension,
  requestExtension,
  getClientOnline,
  getLogs,
  getLogsSummary,
  exportLogs,
};
