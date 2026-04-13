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

    console.log(`🔌 [SOCKET] New connection: ${socket.id}`);
    console.log(`📋 [SOCKET] Auth data:`, { shopId, machineId, label, version });

    // Join room để REST có thể emit đúng client nếu cần
    socket.join(`shop:${shopId}`);
    socket.join(`machine:${machineId}`);

    console.log(`🏠 [SOCKET] Socket ${socket.id} joined rooms:`, [`shop:${shopId}`, `machine:${machineId}`]);
    console.log(`📊 [SOCKET] Room machine:${machineId} now has ${io.sockets.adapter.rooms.get(`machine:${machineId}`)?.size || 0} sockets`);

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

    // Send welcome message với connection info
    socket.emit("server:connected", {
      socketId: socket.id,
      serverTime: Date.now(),
      message: "Connected successfully to LNG Portal",
      rooms: [`shop:${shopId}`, `machine:${machineId}`]
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

    // Task Acknowledgment - Client xác nhận đã nhận task
    socket.on("ext:task-ack", (data) => {
      const { taskId, receivedAt } = data;
      console.log(`✅ [SOCKET] Task acknowledged: ${taskId} by ${machineId} at ${new Date(receivedAt).toISOString()}`);
      
      // Broadcast task acknowledgment to monitoring clients
      io.to(`shop:${shopId}`).emit("task:acknowledged", {
        taskId,
        machineId,
        shopId,
        acknowledgedAt: Date.now(),
        receivedAt,
        latency: Date.now() - receivedAt
      });
    });

    // Task Result - Client gửi kết quả thực hiện task
    socket.on("ext:task-result", (data) => {
      const { taskId, success, result, error, duration, completedAt } = data;
      console.log(`📊 [SOCKET] Task result: ${taskId} - Success: ${success} - Duration: ${duration}ms`);
      
      // Broadcast task result to monitoring clients
      io.to(`shop:${shopId}`).emit("task:completed", {
        taskId,
        machineId,
        shopId,
        success,
        result,
        error,
        duration,
        completedAt,
        receivedAt: Date.now()
      });

      // Log to console for debugging
      if (!success && error) {
        console.error(`❌ [SOCKET] Task ${taskId} failed on ${machineId}: ${error}`);
      }
    });

    // Task Progress - Client gửi tiến độ thực hiện task
    socket.on("ext:task-progress", (data) => {
      const { taskId, progress, message, currentStep, totalSteps } = data;
      console.log(`🔄 [SOCKET] Task progress: ${taskId} - ${progress}% - ${message}`);
      
      // Broadcast progress to monitoring clients
      io.to(`shop:${shopId}`).emit("task:progress", {
        taskId,
        machineId,
        shopId,
        progress,
        message,
        currentStep,
        totalSteps,
        timestamp: Date.now()
      });
    });

    // Real-time Data - Client gửi dữ liệu real-time bất kỳ
    socket.on("ext:realtime-data", (data) => {
      const { type, payload, timestamp } = data;
      console.log(`📡 [SOCKET] Real-time data from ${machineId}:`, { type, timestamp });
      
      // Broadcast to monitoring clients and other relevant clients
      io.to(`shop:${shopId}`).emit("client:realtime-data", {
        machineId,
        shopId,
        type,
        payload,
        timestamp: timestamp || Date.now(),
        receivedAt: Date.now()
      });
    });

    // Connection Test - Ping/Pong để test kết nối
    socket.on("ext:ping", (data) => {
      const { timestamp, testId } = data;
      const now = Date.now();
      const latency = now - timestamp;
      
      console.log(`🏓 [SOCKET] Ping from ${machineId} - Latency: ${latency}ms`);
      
      // Gửi pong ngược lại client
      socket.emit("server:pong", {
        testId,
        clientTimestamp: timestamp,
        serverTimestamp: now,
        latency
      });
      
      // Broadcast connection quality to monitoring
      io.to(`shop:${shopId}`).emit("connection:quality", {
        machineId,
        shopId,
        latency,
        timestamp: now,
        quality: latency < 100 ? 'excellent' : latency < 300 ? 'good' : latency < 1000 ? 'fair' : 'poor'
      });
    });

    // System Stats - Client gửi thông tin hệ thống
    socket.on("ext:system-stats", (data) => {
      const { cpu, memory, activeOrders, queueSize, errors, uptime } = data;
      console.log(`📊 [SOCKET] System stats from ${machineId}:`, { cpu, memory, activeOrders });
      
      // Update presence with system info
      presence.updateStats(machineId, {
        cpu,
        memory,
        activeOrders,
        queueSize,
        errors,
        uptime,
        lastStatsUpdate: Date.now()
      });
      
      // Broadcast to monitoring dashboard
      io.to(`shop:${shopId}`).emit("client:stats", {
        machineId,
        shopId,
        stats: { cpu, memory, activeOrders, queueSize, errors, uptime },
        timestamp: Date.now()
      });
    });

    // Error Report - Client báo lỗi real-time
    socket.on("ext:error-report", (data) => {
      const { error, context, severity, timestamp } = data;
      console.error(`🚨 [SOCKET] Error from ${machineId}:`, { error, severity, context });
      
      // Broadcast error to monitoring
      io.to(`shop:${shopId}`).emit("client:error", {
        machineId,
        shopId,
        error,
        context,
        severity,
        timestamp: timestamp || Date.now(),
        receivedAt: Date.now()
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
