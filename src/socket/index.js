// src/socket/index.js
const presence = require("../lib/presence");
const Shop = require("../models/shop.model");
const ExtensionTask = require("../models/extensionTask.model");
const taskStatusService = require("../service/taskStatus.service");
const { upsertEtsyMessageThreads } = require("../service/etsyMessage.service");

const PENDING_TASK_REPLAY_MS = 24 * 60 * 60 * 1000;

async function saveClientPresence({ shopId, machineId, label, version, status, touchLastSeen }) {
  const now = new Date();
  const update = {
    "clients.$.label": label || "",
    "clients.$.version": version || "",
    "clients.$.status": status,
  };
  if (touchLastSeen) update["clients.$.lastSeen"] = now;
  if (status === "online") update["clients.$.disconnectedAt"] = null;
  if (status === "offline") update["clients.$.disconnectedAt"] = now;

  const result = await Shop.updateOne(
    { _id: shopId, "clients.clientId": machineId },
    { $set: update }
  );
  if (result.matchedCount) return;

  await Shop.updateOne(
    { _id: shopId },
    {
      $push: {
        clients: {
          clientId: machineId,
          label: label || "",
          version: version || "",
          status,
          firstSeen: now,
          lastSeen: now,
          disconnectedAt: status === "offline" ? now : null,
        },
      },
    }
  );
}

function persistClientPresence(data) {
  saveClientPresence(data).catch((error) =>
    console.error("[SOCKET] Could not persist client presence:", error.message)
  );
}

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
    persistClientPresence({ shopId, machineId, label, version, status: "online", touchLastSeen: true });

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

    // Heartbeat — BẮT BUỘC ACK callback để extension không tăng heartbeatFailCount
    socket.on("ext:heartbeat", (p = {}, ack) => {
      try {
        presence.heartbeat(machineId, {
          label: p.label,
          version: p.version,
          ua: p.ua,
          ip: p.ip,
        });
        persistClientPresence({
          shopId,
          machineId,
          label: p.label || label,
          version: p.version || version,
          status: "online",
          touchLastSeen: true,
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
        if (typeof ack === "function") {
          ack({ ok: true, serverTs: Date.now() });
        }
      } catch (err) {
        console.error("[SOCKET] ext:heartbeat error:", err.message);
        if (typeof ack === "function") {
          ack({ ok: false, message: err.message });
        }
      }
    });

    socket.on("client:etsy_message", async (payload = {}, ack) => {
      try {
        const messages = Array.isArray(payload?.result?.messages)
          ? payload.result.messages
          : [];
        const targetShopId = String(payload.shopId || shopId);
        const targetMachineId = String(payload.machineId || machineId);

        console.log("[SOCKET][client:etsy_message]", {
          shopId: targetShopId,
          machineId: targetMachineId,
          eventId: payload.eventId,
          messagesCount: messages.length,
          totalThreads: payload?.result?.totalThreads,
        });

        const saveResult = await upsertEtsyMessageThreads({
          ...payload,
          shopId: targetShopId,
          machineId: targetMachineId,
        });

        io.to(`shop:${targetShopId}`).emit("etsy_message:new", {
          shopId: targetShopId,
          machineId: targetMachineId,
          eventId: payload.eventId,
          messages: saveResult.items,
          messagesCount: saveResult.saved,
          totalThreads: payload?.result?.totalThreads || 0,
          syncedAt: payload?.result?.syncedAt || new Date().toISOString(),
          at: Date.now(),
        });

        if (typeof ack === "function") {
          ack({
            ok: saveResult.ok === true,
            received: true,
            eventId: payload.eventId,
            messagesCount: messages.length,
            saved: saveResult.saved,
            failed: saveResult.failed || 0,
            errors: saveResult.errors || [],
          });
        }
      } catch (err) {
        console.error("[SOCKET][client:etsy_message] error:", err.message || err);

        if (typeof ack === "function") {
          ack({ ok: false, message: err.message || String(err) });
        }
      }
    });

    // client:task — Extension gửi status received/completed/failed (idempotent theo eventId)
    socket.on("client:task", async (payload = {}, ack) => {
      try {
        const result = await taskStatusService.upsertByEventId({
          eventId: payload.eventId,
          taskId: payload.taskId,
          type: payload.type,
          status: payload.status,
          shopId: payload.shopId || shopId,
          machineId: payload.machineId || machineId,
          result: payload.result,
          error: payload.error,
          source: payload.source || "chrome_extension",
          reportedAt: payload.reportedAt,
          rawPayload: payload,
        });

        console.log(
          `📨 [TASK_REPLY] status=${payload.status} taskId=${payload.taskId} machineId=${machineId} deduped=${result.deduped}${payload.error ? ` error=${String(payload.error).slice(0, 200)}` : ""}`
        );

        // Broadcast cho monitor dashboard
        io.to(`shop:${shopId}`).emit("task:status", {
          taskId: payload.taskId,
          eventId: payload.eventId,
          status: payload.status,
          machineId,
          shopId,
          deduped: result.deduped,
          at: Date.now(),
        });

        if (typeof ack === "function") {
          ack({ ok: true, eventId: payload.eventId, deduped: result.deduped });
        }
      } catch (err) {
        console.error("[SOCKET] client:task error:", err.message);
        if (typeof ack === "function") {
          ack({ ok: false, message: err.message });
        }
      }
    });

    // Only resend a fresh task that has not been acknowledged. A received task
    // may already be executing, so replaying it on reconnect can duplicate work.
    socket.on("client:pull_pending_tasks", async (payload = {}, ack) => {
      try {
        const targetMachineId = payload.machineId || machineId;
        const targetShopId = payload.shopId || shopId;
        const now = new Date();

        await taskStatusService.expireUnacknowledgedTasks({ now });

        const pending = await taskStatusService.findPendingTasks({
          shopId: targetShopId,
          machineId: targetMachineId,
          statuses: ["sent"],
          sentAfter: new Date(now.getTime() - PENDING_TASK_REPLAY_MS),
        });

        for (const t of pending) {
          socket.emit("server:task", {
            taskId: t.taskId,
            type: t.type,
            payload: t.payload,
            sentAt: (t.sentAt || t.createdAt || new Date()).toISOString
              ? (t.sentAt || t.createdAt || new Date()).toISOString()
              : new Date().toISOString(),
            resent: true,
          });
          await ExtensionTask.updateOne(
            { taskId: t.taskId, status: "sent" },
            { $inc: { resendCount: 1 }, $set: { lastResentAt: now } }
          );
        }

        console.log(
          `🔁 [SOCKET] Resent ${pending.length} pending tasks to machine:${targetMachineId}`
        );

        if (typeof ack === "function") {
          ack({ ok: true, count: pending.length });
        }
      } catch (err) {
        console.error("[SOCKET] client:pull_pending_tasks error:", err.message);
        if (typeof ack === "function") {
          ack({ ok: false, message: err.message });
        }
      }
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
      const currentClient = presence.getByMachine(machineId);
      if (currentClient?.socketId !== socket.id) return;
      presence.offline(machineId, socket.id);
      persistClientPresence({ shopId, machineId, label, version, status: "offline", touchLastSeen: false });
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
