// src/socket/index.js
const presence = require("../lib/presence");

module.exports = function registerSocketHandlers({ app, io }) {
  app.set("io", io);
  app.set("presence", presence);

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

    // Join room để REST có thể emit đúng client nếu cần
    socket.join(`shop:${shopId}`);
    socket.join(`machine:${machineId}`);

    // ONLINE
    presence.online({
      shopId,
      machineId,
      label,
      version,
      socketId: socket.id,
      ua,
      ip,
    });

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

    // Heartbeat
    socket.on("ext:heartbeat", (p = {}) => {
      presence.heartbeat(machineId, {
        label: p.label,
        version: p.version,
        ua: p.ua,
        ip: p.ip,
      });
      io.to(`shop:${shopId}`).emit("presence:update", {
        kind: "heartbeat",
        at: Date.now(),
        client: {
          shopId,
          machineId,
          label: p.label || label || `Client ${machineId}`,
          version: p.version || version || "",
          socketId: socket.id,
          ua: p.ua || ua || "",
          ip: p.ip || ip || "",
          status: "online",
          lastSeen: Date.now(),
        },
      });
    });

    // OFFLINE
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
