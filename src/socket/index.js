// src/socket/index.js
// Realtime minimal: presence + task started/finished + (optional) ack
const presence = require("../lib/presence");

module.exports = function registerSocketHandlers({ app, io }) {
  // --- Auth đơn giản ---
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

    // --- join rooms ---
    socket.join(`shop:${shopId}`);
    socket.join(`machine:${machineId}`);

    // --- presence online ---
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

    socket.on("fe:command", (cmd = {}) => {
      const { shopId, machineId, type, payload } = cmd;
      if (!shopId || !machineId || !type) {
        // trả lại nhanh cho FE biết request không hợp lệ
        socket.emit("fe:command:rejected", {
          at: Date.now(),
          reason: "shopId, machineId, type required",
        });
        return;
      }

      const jobId = `job_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // bắn trực tiếp theo room machine (Extension đã join machine:<id>)
      io.to(`machine:${machineId}`).emit("server:task", {
        jobId,
        type, // "IMPORT_ORDERS" | "IMPORT_ADS_SPEND" (vẫn giữ logic cũ)
        payload: payload || {},
      });

      // xác nhận “đã nhận” ngay cho FE (không chờ Extension)
      socket.emit("fe:command:accepted", {
        at: Date.now(),
        jobId,
        type,
        machineId,
      });
    });

    // --- disconnect ---
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
