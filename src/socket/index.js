// src/socket/index.js
// Đăng ký toàn bộ “socket routes” ở đây.
// Gọi từ server.js: registerSocketHandlers({ app, io })

const db = require("../models");
const Shop = db.shop;
const RealtimeLog = db.RealtimeLog;

module.exports = function registerSocketHandlers({ app, io }) {
  // Auth đơn giản (có thể thay bằng verify JWT)
  io.use((socket, next) => {
    const { shopId, machineId, label, version, ua } =
      socket.handshake.auth || {};
    if (!shopId) return next(new Error("shopId required"));
    if (!machineId) return next(new Error("machineId required"));
    socket.data.shopId = String(shopId);
    socket.data.machineId = String(machineId);
    socket.data.label = label || null;
    socket.data.version = version || "";
    socket.data.ua = ua || socket.handshake.headers["user-agent"] || "";
    next();
  });

  io.on("connection", async (socket) => {
    const { shopId, machineId } = socket.data;
    socket.join(`machine:${machineId}`);

    const ip =
      (socket.handshake.headers["x-forwarded-for"] || "")
        .toString()
        .split(",")[0]
        .trim() ||
      socket.handshake.address ||
      "";

    // ONLINE + lưu socketId
    try {
      await Shop.updateOne(
        { _id: shopId, "clients.machineId": machineId },
        {
          $set: {
            "clients.$.status": "online",
            "clients.$.lastSeen": new Date(),
            "clients.$.socketId": socket.id,
            "clients.$.ua": socket.data.ua,
            "clients.$.ip": ip,
            "clients.$.version": socket.data.version,
            "clients.$.label": socket.data.label || `Client ${machineId}`,
            "clients.$.clientId": machineId, // tương thích FE cũ
          },
        }
      );
    } catch {}

    try {
      await RealtimeLog.create({
        ts: Date.now(),
        type: "SOCKET_CONNECTED",
        day: new Date().toISOString().slice(0, 10),
        clientId: machineId,
        meta: { shopId, socketId: socket.id, ip },
      });
    } catch {}

    // Heartbeat từ extension
    socket.on("ext:heartbeat", async (payload = {}) => {
      try {
        await Shop.updateOne(
          { _id: shopId, "clients.machineId": machineId },
          {
            $set: {
              "clients.$.status": "online",
              "clients.$.lastSeen": new Date(),
              ...(payload.version
                ? { "clients.$.version": payload.version }
                : {}),
              ...(payload.label ? { "clients.$.label": payload.label } : {}),
              ...(payload.ua ? { "clients.$.ua": payload.ua } : {}),
              ...(payload.ip ? { "clients.$.ip": payload.ip } : {}),
            },
          }
        );
      } catch {}
    });

    // Client gửi ACK cho job (nếu HTTP API /command yêu cầu chờ)
    socket.on("client:ack", (ack) => {
      const ackMap = socket.request.app.get("ackMap");
      const resolver = ackMap && ackMap.get(ack?.jobId);
      if (resolver) {
        ackMap.delete(ack.jobId);
        resolver({
          ok: !!ack.ok,
          result: ack.result || null,
          error: ack.error || null,
        });
      }
      // optional log
      (async () => {
        try {
          await RealtimeLog.create({
            ts: Date.now(),
            type: "CLIENT_ACK",
            day: new Date().toISOString().slice(0, 10),
            clientId: machineId,
            meta: { shopId, jobId: ack?.jobId, ok: !!ack?.ok },
          });
        } catch {}
      })();
    });

    socket.on("disconnect", async (reason) => {
      try {
        await Shop.updateOne(
          { _id: shopId, "clients.machineId": machineId },
          {
            $set: {
              "clients.$.status": "offline",
              "clients.$.lastSeen": new Date(),
              "clients.$.socketId": null,
            },
          }
        );
      } catch {}
      try {
        await RealtimeLog.create({
          ts: Date.now(),
          type: "SOCKET_DISCONNECTED",
          day: new Date().toISOString().slice(0, 10),
          clientId: machineId,
          meta: { shopId, reason },
        });
      } catch {}
    });
  });
};
