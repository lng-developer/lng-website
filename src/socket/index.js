// src/socket/index.js
// Minimal Socket.IO: presence + room join. No lightweight logs, no command handling here.
const presence = require("../lib/presence");

module.exports = function registerSocketHandlers({ app, io }) {
  // Lưu io & presence để chỗ khác (REST) dùng
  app.set("io", io);
  app.set("presence", presence);

  // Auth đơn giản (có thể thay verify JWT)
  io.use((socket, next) => {
    const { shopId, machineId, label, version, ua } =
      socket.handshake.auth || {};
    if (!shopId) return next(new Error("shopId required"));
    if (!machineId) return next(new Error("machineId required"));
    socket.data = {
      shopId: String(shopId),
      machineId: String(machineId),
      label: label || null,
      version: version || "",
      ua: ua || socket.handshake.headers["user-agent"] || "",
    };
    next();
  });

  io.on("connection", (socket) => {
    const { shopId, machineId, label, version, ua } = socket.data;
    const ip =
      (socket.handshake.headers["x-forwarded-for"] || "")
        .toString()
        .split(",")[0]
        .trim() ||
      socket.handshake.address ||
      "";

    // Join rooms để REST có thể emit đến đúng client:
    //   io.to(`machine:${machineId}`).emit("server:task", task)
    socket.join(`shop:${shopId}`);
    socket.join(`machine:${machineId}`);

    // Presence ONLINE (RAM)
    presence.online({
      shopId,
      machineId,
      label,
      version,
      socketId: socket.id,
      ua,
      ip,
    });

    // Báo FE biết thay đổi trạng thái (nếu FE đang theo dõi)
    io.to(`shop:${shopId}`).emit("presence:update", {
      kind: "online",
      at: Date.now(),
      client: {
        shopId,
        machineId,
        label,
        version,
        socketId: socket.id,
        ua,
        ip,
        status: "online",
        lastSeen: Date.now(),
      },
    });

    // Heartbeat từ extension → cập nhật presence
    socket.on("ext:heartbeat", (payload = {}) => {
      presence.heartbeat(machineId, {
        label: payload.label,
        version: payload.version,
        ua: payload.ua,
        ip: payload.ip,
      });

      io.to(`shop:${shopId}`).emit("presence:update", {
        kind: "heartbeat",
        at: Date.now(),
        client: {
          shopId,
          machineId,
          label: payload.label || label || `Client ${machineId}`,
          version: payload.version || version || "",
          socketId: socket.id,
          ua: payload.ua || ua || "",
          ip: payload.ip || ip || "",
          status: "online",
          lastSeen: Date.now(),
        },
      });
    });

    // Ngắt kết nối → OFFLINE
    socket.on("disconnect", (reason) => {
      presence.offline(machineId);
      io.to(`shop:${shopId}`).emit("presence:update", {
        kind: "offline",
        at: Date.now(),
        client: {
          shopId,
          machineId,
          label,
          version,
          socketId: null,
          ua,
          ip,
          status: "offline",
          lastSeen: Date.now(),
        },
        reason,
      });
    });
  });
};
