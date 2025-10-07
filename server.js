const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();
const path = require("path");
const connectDB = require("./src/config/db.config");
const {
  roleRoutes,
  userRoutes,
  accountRoutes,
  authRoutes,
  orderCustomProductRoutes,
  shopRoutes,
  vendorRoutes,
  vendorProductRoutes,
  vendorCostCenterRoutes,
  caseRoutes,
  listingRoutes,
  productTypeRoutes,
  configCostCenterRoutes,
  configOptionMappingRoutes,
  scaleRoutes,
  QCRoutes,
  reportRoutes,
  adsRoutes,
  skuMappingRoutes,
  APORoutes,
  PsdTaskRoutes,
  ideaTaskRoutes,
} = require("./src/routes");

const app = express();
app.set("trust proxy", true); // tốt cho IP sau Nginx
app.use(express.json());
app.use(morgan("dev"));
app.use(cors());

// Root Route
app.get("/", (req, res) => {
  res.json({ message: "Welcome to RESTful API - Node.js" });
});

// API Routes (GIỮ NGUYÊN)
app.use("/api/role", roleRoutes);
app.use("/api/user", userRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/order", orderCustomProductRoutes);
app.use("/api/shop", shopRoutes);
app.use("/api/vendor", vendorRoutes);
app.use("/api/vendor-product", vendorProductRoutes);
app.use("/api/vendor-cost-center", vendorCostCenterRoutes);
app.use("/api/case", caseRoutes);
app.use("/api/listing", listingRoutes);
app.use("/api/product-type", productTypeRoutes);
app.use("/api/config-cost-center", configCostCenterRoutes);
app.use("/api/scale", scaleRoutes);
app.use("/api/fulfillment/qc", QCRoutes);
app.use("/api/mapping", configOptionMappingRoutes);
app.use("/api/report", reportRoutes);
app.use("/api/ads", adsRoutes);
app.use("/api/sku-mapping", skuMappingRoutes);
app.use("/APO", APORoutes);
app.use("/api/psd-task", PsdTaskRoutes);
app.use("/api/idea-task", ideaTaskRoutes);

// Error Handler
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({
    error: { message: err.message || "Internal Server Error" },
  });
});

// ======= Realtime (Socket.IO) =======
const http = require("http");
const { Server } = require("socket.io");

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  path: "/socket",
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

// Sổ client + log + job (in-memory)
const clients = new Map(); // socket.id -> { clientId, label, version, ua, ip, connectedAt, lastSeen }
const logs = []; // push { ts, type, data }
const jobs = new Map(); // jobId -> { createdAt, reason, acks:Set, events:[] }
const MAX_LOGS = Number(process.env.MAX_RT_LOGS || 5000);

function addLog(type, data = {}) {
  logs.push({ ts: Date.now(), type, data });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  // log nhẹ cho console
  const slim = { ...data };
  if (slim.text && String(slim.text).length > 120)
    slim.text = String(slim.text).slice(0, 120) + "…";
  console.log(`[${type}]`, slim);
}

// Socket events
io.on("connection", (socket) => {
  const ip =
    socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  clients.set(socket.id, {
    socketId: socket.id,
    clientId: null,
    label: null,
    version: null,
    ua: socket.handshake.headers["user-agent"],
    ip,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
  });
  addLog("CONNECT", { socketId: socket.id, ip });

  socket.on("HELLO", (info) => {
    const c = clients.get(socket.id);
    if (!c) return;
    c.clientId = info?.clientId || null;
    c.label = info?.label || null;
    c.version = info?.version || null;
    c.lastSeen = Date.now();
    addLog("HELLO", {
      socketId: socket.id,
      clientId: c.clientId,
      label: c.label,
      version: c.version,
    });
  });

  socket.on("ACK", (ack) => {
    const c = clients.get(socket.id);
    if (c) c.lastSeen = Date.now();

    const jobId = ack?.jobId;
    if (jobId) {
      if (!jobs.has(jobId))
        jobs.set(jobId, {
          createdAt: Date.now(),
          reason: "unknown",
          acks: new Set(),
          events: [],
        });
      jobs.get(jobId).acks.add(c?.clientId || c?.socketId);
    }
    addLog("ACK", {
      socketId: socket.id,
      clientId: c?.clientId,
      label: c?.label,
      jobId,
    });
  });

  // STATUS: { jobId, phase:'import'|'report'|'ads'|'config', status:'start'|'success'|'fail', httpStatus?, ms?, error? }
  socket.on("STATUS", (st) => {
    const c = clients.get(socket.id);
    if (c) c.lastSeen = Date.now();
    addLog("STATUS", {
      socketId: socket.id,
      clientId: c?.clientId,
      label: c?.label,
      ...st,
    });

    const jobId = st?.jobId;
    if (jobId) {
      if (!jobs.has(jobId))
        jobs.set(jobId, {
          createdAt: Date.now(),
          reason: "unknown",
          acks: new Set(),
          events: [],
        });
      jobs.get(jobId).events.push({
        ts: Date.now(),
        clientId: c?.clientId || c?.socketId,
        ...st,
      });
    }
  });

  socket.on("disconnect", (reason) => {
    addLog("DISCONNECT", { socketId: socket.id, reason });
    clients.delete(socket.id);
  });
});

// ===== REST: health / clients / logs =====
app.get("/health", (_req, res) => res.send("ok"));

app.get("/clients", (_req, res) => {
  res.json([...clients.values()]);
});

app.get("/jobs", (_req, res) => {
  res.json([...jobs.values()]);
});

// /logs?type=STATUS&jobId=123&clientId=ABC&limit=200
app.get("/logs", (req, res) => {
  const { type, jobId, clientId } = req.query;
  let out = logs;
  if (type) out = out.filter((l) => l.type === type);
  if (jobId)
    out = out.filter(
      (l) => l.data?.jobId === jobId || l.data?.payload?.jobId === jobId
    );
  if (clientId)
    out = out.filter(
      (l) => l.data?.clientId === clientId || l.data?.label === clientId
    );
  const n = Math.min(parseInt(req.query.limit || "200", 10), 1000);
  res.json(out.slice(-n));
});

// ===== Legacy: phát job test (giữ nguyên) =====
// Phát "RUN_JOB" + đồng thời phát "RUN_NOW" kèm jobId để client mới chạy luôn
app.post("/run-now", (req, res) => {
  const jobId = String(Date.now());
  const reason = req.body?.reason || "manual";
  const payload = { jobId, reason };

  if (!jobs.has(jobId))
    jobs.set(jobId, {
      createdAt: Date.now(),
      reason,
      acks: new Set(),
      events: [],
    });

  io.emit("RUN_JOB", payload); // client cũ (ack/log)
  io.emit("RUN_NOW", { type: "RUN_NOW", ...payload }); // client mới (thực thi 3 bước)
  addLog("RUN_JOB", payload);
  addLog("RUN_NOW", payload);

  res.json({ ok: true, ...payload });
});

// ===== Admin APIs để backend điều khiển extension =====

// Đặt lịch auto (bật/tắt + chu kỳ phút/ms)
app.post("/admin/schedule", (req, res) => {
  const { enabled = true, intervalMin, intervalMs } = req.body || {};
  const payload = { type: "SYNC_CONFIG", enabled: !!enabled };
  if (typeof intervalMin === "number")
    payload.intervalMin = Number(intervalMin);
  if (typeof intervalMs === "number") payload.intervalMs = Number(intervalMs);

  io.emit("SYNC_CONFIG", payload);
  addLog("SYNC_CONFIG", payload);
  res.json({ ok: true, payload });
});

// Chạy ngay 3 bước và theo dõi bằng jobId
app.post("/admin/run-now", (req, res) => {
  const jobId = String(Date.now());
  const reason = req.body?.reason || "manual";
  jobs.set(jobId, {
    createdAt: Date.now(),
    reason,
    acks: new Set(),
    events: [],
  });

  const payload = { type: "RUN_NOW", jobId, reason };
  io.emit("RUN_NOW", payload);
  addLog("RUN_NOW", payload);

  res.json({ ok: true, jobId, reason });
});

// Tóm tắt 1 job: ai ACK, phase success/fail theo từng client
app.get("/admin/job/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const j = jobs.get(jobId);
  if (!j) return res.status(404).json({ ok: false, message: "job not found" });

  const phases = ["import", "report", "ads", "config"];
  const summary = {
    jobId,
    createdAt: j.createdAt,
    reason: j.reason,
    ackCount: j.acks.size,
    acks: [...j.acks],
  };

  const perClient = {}; // clientId -> { import:'success'|'fail'|'start'|undefined, ... }
  for (const ev of j.events) {
    const cid = ev.clientId || "unknown";
    if (!perClient[cid]) perClient[cid] = {};
    perClient[cid][ev.phase] = ev.status;
  }

  const counts = {};
  for (const p of phases) {
    counts[p] = { success: 0, fail: 0 };
    Object.values(perClient).forEach((pc) => {
      if (pc[p] === "success") counts[p].success++;
      if (pc[p] === "fail") counts[p].fail++;
    });
  }

  res.json({
    ok: true,
    summary,
    counts,
    perClient,
    events: j.events.slice(-200),
  });
});

// ===== Run Server =====
const PORT = process.env.PORT || 5000;
connectDB();
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🚀 HTTP + Socket.IO running at http://localhost:${PORT}  (path /socket)`
  );
});
