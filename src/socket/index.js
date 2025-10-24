// src/socket/index.js
// Đăng ký toàn bộ “socket routes” ở đây.
// Gọi từ server.js: registerSocketHandlers({ app, io })

// ✅ Realtime only (no DB writes)
const presence = require("../lib/presence");

// (tuỳ chọn) dùng logbus RAM để lưu log gần nhất nếu bạn có file lib/logbus.js
let logbus;
try {
  logbus = require("../lib/logbus");
} catch {
  logbus = { append: () => {}, query: () => [] };
}

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

  io.on("connection", (socket) => {
    const { shopId, machineId, label, version, ua } = socket.data;
    const ip =
      (socket.handshake.headers["x-forwarded-for"] || "")
        .toString()
        .split(",")[0]
        .trim() ||
      socket.handshake.address ||
      "";

    // Mark presence ONLINE in RAM
    presence.online({
      shopId,
      machineId,
      label,
      version,
      socketId: socket.id,
      ua: ua || socket.handshake.headers["user-agent"] || "",
      ip,
    });

    // Notify FE (realtime)
    io.emit("presence:update", {
      kind: "online",
      at: Date.now(),
      client: {
        shopId,
        machineId,
        label: label || `Client ${machineId}`,
        version: version || "",
        socketId: socket.id,
        ua: ua || "",
        ip,
        lastSeen: Date.now(),
        status: "online",
      },
    });

    /* ===========================================================
       💬 EXTENSION → SERVER: gửi log realtime
       FE sẽ xem log qua event "realtime:log"
    ============================================================ */
    socket.on("ext:log", (payload = {}) => {
      const event = {
        at: payload.at || Date.now(),
        shopId,
        machineId,
        type: payload.type || "info", // info | step | done | error | warn
        message: payload.message || "",
        ...payload,
      };

      // 1️⃣ Phát realtime tới toàn bộ FE
      io.emit("realtime:log", event);

      // 2️⃣ (Tuỳ chọn) chỉ phát theo shop nếu FE join room
      io.to(`shop:${shopId}`).emit("realtime:log", event);

      // 3️⃣ (Tuỳ chọn) lưu RAM log để FE load lại qua REST
      logbus.append(event);
    });

    /* ===========================================================
       🔁 HEARTBEAT từ extension
    ============================================================ */
    socket.on("ext:heartbeat", (payload = {}) => {
      presence.heartbeat(machineId, {
        label: payload.label,
        version: payload.version,
        ua: payload.ua,
        ip: payload.ip,
      });

      // Bắn realtime để FE cập nhật lastSeen/status
      io.emit("presence:update", {
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
          lastSeen: Date.now(),
          status: "online",
        },
      });
    });

    /* ===========================================================
       ✅ CLIENT ACK (khi extension hoàn thành job)
    ============================================================ */
    socket.on("client:ack", (ack) => {
      const payload = {
        at: Date.now(),
        shopId,
        machineId,
        jobId: ack?.jobId || null,
        ok: !!ack?.ok,
        result: ack?.result || null,
        error: ack?.error || null,
        type: "ack",
        message: `ACK job ${ack?.jobId || "?"} → ${
          ack?.ok ? "✅ success" : "❌ fail"
        }`,
      };

      // Gửi realtime log để FE thấy luôn
      io.emit("realtime:log", payload);
      io.to(`shop:${shopId}`).emit("realtime:log", payload);
      logbus.append(payload);

      // Nếu HTTP /command đang chờ ACK, resolve promise
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

    /* ===========================================================
       🔌 DISCONNECT
    ============================================================ */
    socket.on("disconnect", (reason) => {
      presence.offline(machineId);

      io.emit("presence:update", {
        kind: "offline",
        at: Date.now(),
        client: {
          shopId,
          machineId,
          label: label || `Client ${machineId}`,
          version: version || "",
          socketId: null,
          ua: ua || "",
          ip,
          lastSeen: Date.now(),
          status: "offline",
        },
        reason,
      });
    });
  });
};
