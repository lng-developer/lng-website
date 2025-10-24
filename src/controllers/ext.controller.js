const db = require("../models");
const Shop = db.shop;
const RealtimeLog = db.RealtimeLog;
const logbus = require("../lib/logbus");

// Helpers
function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function ensureAckMap(app) {
  let ackMap = app.get("ackMap");
  if (!ackMap) {
    ackMap = new Map();
    app.set("ackMap", ackMap);
  }
  return ackMap;
}

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

const requestExtension = async (req, res) => {
  try {
    const io = req.app.get("io");
    if (!io)
      return res.status(500).json({ ok: false, message: "io not ready" });

    const {
      shopId,
      machineId,
      type,
      status,
      date,
      requireAck = false,
    } = req.body || {};
    if (!shopId)
      return res.status(400).json({ ok: false, message: "shopId required" });
    if (!machineId)
      return res.status(400).json({ ok: false, message: "machineId required" });
    if (!type)
      return res.status(400).json({ ok: false, message: "type required" });
    if (!status)
      return res.status(400).json({ ok: false, message: "status required" });

    const allowed = new Set(["IMPORT_ORDERS", "IMPORT_ADS_SPEND"]);
    if (!allowed.has(type))
      return res
        .status(400)
        .json({ ok: false, message: "Unsupported command type" });

    const shop = await Shop.findOne(
      { _id: shopId },
      { _id: 1, clients: 1 }
    ).lean();
    if (!shop)
      return res.status(404).json({ ok: false, message: "Shop not found" });

    const client = (shop.clients || []).find(
      (c) => (c.machineId || c.clientId) === machineId
    );
    if (!client)
      return res
        .status(404)
        .json({ ok: false, message: "Client not found in shop" });
    if (client.status !== "online")
      return res.status(409).json({ ok: false, message: "Client is offline" });

    const jobId = newJobId();
    const payload = { status: String(status) };
    if (type === "IMPORT_ADS_SPEND") {
      payload.date = date || new Date().toISOString().slice(0, 10);
    }

    const task = { jobId, type, payload, ts: Date.now(), from: "API" };
    io.to(`machine:${machineId}`).emit("server:task", task);

    try {
      await RealtimeLog.create({
        ts: Date.now(),
        type: "SERVER_TASK_EMIT",
        day: new Date().toISOString().slice(0, 10),
        clientId: machineId,
        meta: { shopId, jobId, action: type, payload },
      });
    } catch {}

    if (!requireAck) return res.json({ ok: true, enqueued: true, jobId });

    // Chờ ACK ngắn (5s)
    const ackMap = ensureAckMap(req.app);
    const waitMs = 5000;
    let resolveAck;
    const p = new Promise((resolve) => (resolveAck = resolve));
    ackMap.set(jobId, resolveAck);

    const timer = setTimeout(() => {
      if (ackMap.has(jobId)) {
        ackMap.delete(jobId);
        resolveAck({ ok: false, timeout: true });
      }
    }, waitMs);

    const ack = await p;
    clearTimeout(timer);
    res.json({ ok: true, jobId, ack });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};

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
  const {
    shopId = "",
    machineId = "",
    since = 0,
    limit = 200,
  } = req.query || {};
  try {
    const logs = logbus.query({
      shopId: shopId || undefined,
      machineId: machineId || undefined,
      since: Number(since) || 0,
      limit: Math.min(Math.max(Number(limit) || 200, 1), 1000),
    });
    res.json({ ok: true, logs });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
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
