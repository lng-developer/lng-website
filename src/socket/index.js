// socket/index.js
const presence = require("../lib/presence");
const logbus = require("../lib/logbus");

module.exports = function registerSocketHandlers({ app, io }) {
  // Simple auth
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

  io.on("connection", (socket) => {
    const { shopId, machineId, label, version, ua } = socket.data;
    const ip =
      (socket.handshake.headers["x-forwarded-for"] || "")
        .toString()
        .split(",")[0]
        .trim() ||
      socket.handshake.address ||
      "";

    // Join rooms
    socket.join(`shop:${shopId}`);
    socket.join(`machine:${machineId}`);

    presence.online({
      shopId,
      machineId,
      label,
      version,
      socketId: socket.id,
      ua,
      ip,
    });

    io.emit("presence:update", {
      kind: "online",
      at: Date.now(),
      client: {
        shopId,
        machineId,
        label: label || `Client ${machineId}`,
        version,
        socketId: socket.id,
        ua,
        ip,
        lastSeen: Date.now(),
        status: "online",
      },
    });

    // EXT → SERVER log realtime
    socket.on("ext:log", (payload = {}) => {
      const event = {
        at: payload.at || Date.now(),
        shopId,
        machineId,
        type: payload.type || "info", // info|step|done|warn|error
        message: payload.message || "",
        ...payload,
      };
      io.emit("realtime:log", event);
      io.to(`shop:${shopId}`).emit("realtime:log", event);
      logbus.append(event);
    });

    // Heartbeat
    socket.on("ext:heartbeat", (payload = {}) => {
      presence.heartbeat(machineId, {
        label: payload.label,
        version: payload.version,
        ua: payload.ua,
        ip: payload.ip,
      });
      io.emit("presence:update", {
        kind: "heartbeat",
        at: Date.now(),
        client: {
          shopId,
          machineId,
          label: payload.label || label,
          version: payload.version || version,
          socketId: socket.id,
          ua: payload.ua || ua,
          ip: payload.ip || ip,
          lastSeen: Date.now(),
          status: "online",
        },
      });
    });

    // Client ACK
    socket.on("client:ack", (ack) => {
      const event = {
        at: Date.now(),
        type: "ack",
        shopId,
        machineId,
        jobId: ack?.jobId || null,
        ok: !!ack?.ok,
        result: ack?.result || null,
        error: ack?.error || null,
        message: `ACK ${ack?.jobId || "?"} → ${ack?.ok ? "✅" : "❌"}`,
      };
      io.emit("realtime:log", event);
      io.to(`shop:${shopId}`).emit("realtime:log", event);
      logbus.append(event);

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
    });

    socket.on("disconnect", (reason) => {
      presence.offline(machineId);
      io.emit("presence:update", {
        kind: "offline",
        at: Date.now(),
        client: {
          shopId,
          machineId,
          label: label || `Client ${machineId}`,
          version,
          socketId: null,
          ua,
          ip,
          lastSeen: Date.now(),
          status: "offline",
        },
        reason,
      });
    });
  });
};
