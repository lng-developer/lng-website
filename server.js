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
  realtimeLogRoutes, // GIỮ NGUYÊN
} = require("./src/routes");

const db = require("./src/models");
const RealtimeLog = db.RealtimeLog;

const app = express();
app.set("trust proxy", true);
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
app.use("/api/logs", realtimeLogRoutes); // GIỮ NGUYÊN
app.use("/admin/session", require("./src/routes/admin.session.routes"));
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

// ========== STATE NHẸ ==========
const clients = new Map(); // ai đang online

// --- SSE + live buffer (chỉ để hiển thị realtime, không vào DB) ---
const sseClients = new Set();
const liveBuffer = [];
const LIVE_MAX = 1000;

function pushSSE(evt) {
  if (!sseClients.size) return;
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const { res } of sseClients) {
    try {
      res.write(line);
    } catch {}
  }
}
function bufferAndPushSSE(evt) {
  liveBuffer.push(evt);
  if (liveBuffer.length > LIVE_MAX) {
    liveBuffer.splice(0, liveBuffer.length - LIVE_MAX);
  }
  pushSSE(evt);
}

// ===== Helpers build UI/Activity từ DB =====
async function buildPhaseSnapshotFromDB({
  lookbackMs = 48 * 3600 * 1000,
} = {}) {
  const fromTs = Date.now() - lookbackMs;
  const rows = await RealtimeLog.find({ type: "STATUS", ts: { $gte: fromTs } })
    .sort({ ts: -1 })
    .limit(10000)
    .lean();

  const out = {};
  for (const l of rows) {
    const id = l.clientId || l.label || l.socketId || "unknown";
    if (!out[id])
      out[id] = {
        id,
        label: l.label || id,
        phases: {},
        lastTs: 0,
        lastJobId: undefined,
      };
    if (!out[id].phases[l.phase]) {
      out[id].phases[l.phase] = {
        status: l.status,
        ts: l.ts,
        jobId: l.jobId,
        ms: l.ms,
        error: l.error,
      };
      if (l.ts > out[id].lastTs) {
        out[id].lastTs = l.ts;
        out[id].lastJobId = l.jobId;
      }
    }
  }
  for (const id of Object.keys(out)) {
    const sts = Object.values(out[id].phases).map((p) => p.status);
    let overall = "idle";
    if (sts.includes("fail")) overall = "error";
    else if (sts.includes("start")) overall = "running";
    else if (sts.includes("success")) overall = "success";
    out[id].overall = overall;
  }
  return out;
}
// map phase -> tiếng Việt ngắn gọn
const phaseVi = (p) =>
  p === "import"
    ? "Import"
    : p === "report"
    ? "Import report"
    : p === "ads"
    ? "Ads"
    : p || "";

// GHÉP phần “phụ lục” kết quả (nếu có)
function formatExtras(d = {}) {
  const parts = [];
  // các field phổ biến bạn có thể đẩy từ extension
  if (Number.isFinite(d.count)) parts.push(`${d.count} orders`);
  if (Number.isFinite(d.created)) parts.push(`tạo ${d.created}`);
  if (Number.isFinite(d.updated)) parts.push(`cập nhật ${d.updated}`);
  if (Number.isFinite(d.skipped)) parts.push(`bỏ qua ${d.skipped}`);
  if (d.file) parts.push(`file ${d.file}`);
  if (d.reportId) parts.push(`report ${d.reportId}`);
  if (Number.isFinite(d.ms)) parts.push(`${d.ms}ms`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

// CHUYỂN 1 document -> 1 dòng activity cho UI
function makeActivityEntryFromDoc(l) {
  const d = l.meta || {};
  const label = d.label || d.clientId || "Unknown";

  if (l.type === "RUN_NOW") {
    return {
      ts: l.ts,
      type: "info",
      text: "Bắt đầu import orders...",
      meta: { jobId: l.jobId },
    };
  }

  if (l.type === "STATUS") {
    const phaseName = phaseVi(l.phase);
    // Chỉ in S/F (start dùng cho realtime, không cần trong feed DB)
    if (l.status === "success") {
      const extra = formatExtras(d);
      return {
        ts: l.ts,
        type: "success",
        text: `${label}: ${phaseName} thành công${extra}`,
        meta: { client: label, phase: l.phase, jobId: l.jobId },
      };
    }
    if (l.status === "fail") {
      const extra = formatExtras(d);
      return {
        ts: l.ts,
        type: "error",
        text: `${label}: Lỗi ở ${phaseName}${
          l.error ? ` — ${l.error}` : ""
        }${extra}`,
        meta: { client: label, phase: l.phase, jobId: l.jobId },
      };
    }
    // nếu vẫn muốn thấy start trong realtime SSE/Socket,
    // DB view bỏ qua, realtime đã được push qua ADMIN_ACTIVITY rồi.
    return null;
  }

  if (l.type === "SYNC_CONFIG") {
    if (d?.enabled === true) {
      const hours = d.intervalMin
        ? Math.round(d.intervalMin / 60)
        : d.intervalMs
        ? (d.intervalMs / 3600000).toFixed(1)
        : "";
      return {
        ts: l.ts,
        type: "success",
        text: `Đã bật auto import mỗi ${hours || "?"} giờ`,
      };
    }
    if (d?.enabled === false)
      return { ts: l.ts, type: "success", text: "Đã tắt auto import" };
  }

  if (l.type === "CONNECT")
    return { ts: l.ts, type: "info", text: `Client ${l.socketId} đã kết nối` };
  if (l.type === "DISCONNECT")
    return {
      ts: l.ts,
      type: "info",
      text: `Client ${l.socketId} ngắt kết nối`,
    };

  return null;
}

async function buildActivityLogsFromDB({ since, limit = 200 }) {
  const q = {};
  if (since) q.ts = { $gt: Number(since) };
  const rows = await RealtimeLog.find(q)
    .sort({ ts: 1 })
    .limit(Math.min(Number(limit) || 200, 2000))
    .lean();
  const out = [];
  for (const l of rows) {
    const item = makeActivityEntryFromDoc(l);
    if (item) out.push(item);
  }
  return out;
}

// ===== Quy tắc lưu DB: CHỈ import success|fail =====
function shouldPersist(type, data = {}) {
  if (type !== "STATUS") return false;
  const phase = String(data.phase || "").toLowerCase();
  const status = String(data.status || "").toLowerCase();
  return phase === "import" && (status === "success" || status === "fail");
}

// ====== addLog: đẩy realtime (luôn), lưu DB (có điều kiện) ======
async function addLog(type, data = {}) {
  const ts = Date.now();
  const ttlDays = Number(process.env.LOG_TTL_DAYS || 0);
  const expireAt = ttlDays > 0 ? new Date(ts + ttlDays * 86400000) : undefined;

  const evt = {
    ts,
    type,
    data,
    day: new Date(ts).toISOString().slice(0, 10),
    clientId: data.clientId || null,
    label: data.label || null,
    socketId: data.socketId || null,
    jobId: data.jobId || data.payload?.jobId || null,
    phase: data.phase || null,
    status: data.status || null,
    ms: data.ms || null,
    error: data.error || null,
    ...(expireAt ? { expireAt } : {}),
  };

  // realtime cho FE
  bufferAndPushSSE({ ts, type, data });
  io.emit("ADMIN_EVENT", { ts, type, data });
  const act = makeActivityEntryFromDoc({ ...evt, meta: data });
  if (act) io.emit("ADMIN_ACTIVITY", act);

  // lưu DB nếu đạt điều kiện
  if (shouldPersist(type, data)) {
    try {
      await RealtimeLog.create({ ...evt, meta: data });
    } catch (e) {
      console.warn("[LOG-PERSIST] error:", e.message);
    }
  }

  // console gọn
  const slim = { ...data };
  if (slim.text && String(slim.text).length > 120)
    slim.text = String(slim.text).slice(0, 120) + "…";
  console.log(`[${type}]`, slim);
}

// ===== Socket events (extension) =====
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
    addLog("ACK", {
      socketId: socket.id,
      clientId: c?.clientId,
      label: c?.label,
      jobId: ack?.jobId,
    });
  });

  // STATUS: { jobId, phase, status, ms?, error?, count? }
  socket.on("STATUS", (st) => {
    const c = clients.get(socket.id);
    if (c) c.lastSeen = Date.now();
    addLog("STATUS", {
      socketId: socket.id,
      clientId: c?.clientId,
      label: c?.label,
      ...st,
    });
  });

  socket.on("disconnect", (reason) => {
    addLog("DISCONNECT", { socketId: socket.id, reason });
    clients.delete(socket.id);
  });
});

// ===== Helpers build UI từ DB =====

// Build snapshot phase gần nhất cho mỗi client từ DB
async function buildPhaseSnapshotFromDB({
  lookbackMs = 48 * 3600 * 1000,
} = {}) {
  const fromTs = Date.now() - lookbackMs;
  const rows = await RealtimeLog.find({
    type: "STATUS",
    ts: { $gte: fromTs },
  })
    .sort({ ts: -1 })
    .limit(10000)
    .lean();

  const out = {}; // id -> snapshot
  for (const l of rows) {
    const id = l.clientId || l.label || l.socketId || "unknown";
    if (!out[id])
      out[id] = {
        id,
        label: l.label || id,
        phases: {},
        lastTs: 0,
        lastJobId: undefined,
      };
    if (!out[id].phases[l.phase]) {
      out[id].phases[l.phase] = {
        status: l.status,
        ts: l.ts,
        jobId: l.jobId,
        ms: l.ms,
        error: l.error,
      };
      if (l.ts > out[id].lastTs) {
        out[id].lastTs = l.ts;
        out[id].lastJobId = l.jobId;
      }
    }
  }

  for (const id of Object.keys(out)) {
    const phases = out[id].phases;
    const sts = Object.values(phases).map((p) => p.status);
    let overall = "idle";
    if (sts.includes("fail")) overall = "error";
    else if (sts.includes("start")) overall = "running";
    else if (sts.includes("success")) overall = "success";
    out[id].overall = overall;
  }
  return out;
}

// Activity entry (câu chữ) cho UI
function makeActivityEntry(l) {
  const d = l.meta || {};
  const label = d.label || d.clientId || "Unknown";
  if (l.type === "RUN_NOW") {
    return {
      ts: l.ts,
      type: "info",
      text: "Bắt đầu import orders...",
      meta: { jobId: l.jobId },
    };
  }
  if (l.type === "STATUS") {
    const phaseName =
      l.phase === "import"
        ? "Import"
        : l.phase === "report"
        ? "Import report"
        : l.phase === "ads"
        ? "Ads"
        : l.phase;
    if (l.status === "start")
      return {
        ts: l.ts,
        type: "info",
        text: `Đang xử lý ${label} (${phaseName})...`,
        meta: { client: label, phase: l.phase, jobId: l.jobId },
      };
    if (l.status === "success") {
      const extra = d.count ? ` ${d.count} orders` : "";
      return {
        ts: l.ts,
        type: "success",
        text: `${label}: ${phaseName} thành công${extra}`,
        meta: { client: label, phase: l.phase, jobId: l.jobId },
      };
    }
    if (l.status === "fail")
      return {
        ts: l.ts,
        type: "error",
        text: `${label}: Lỗi ở ${phaseName}${l.error ? ` — ${l.error}` : ""}`,
        meta: { client: label, phase: l.phase, jobId: l.jobId },
      };
  }
  if (l.type === "CONNECT")
    return {
      ts: l.ts,
      type: "info",
      text: `Client ${l.socketId} đã kết nối`,
      meta: {},
    };
  if (l.type === "DISCONNECT")
    return {
      ts: l.ts,
      type: "info",
      text: `Client ${l.socketId} ngắt kết nối`,
      meta: {},
    };
  return null;
}

async function buildActivityLogsFromDB({ since, limit = 200 }) {
  const q = {};
  if (since) q.ts = { $gt: Number(since) };

  const rows = await RealtimeLog.find(q)
    .sort({ ts: 1 }) // chronological để append vào UI
    .limit(Math.min(Number(limit) || 200, 2000))
    .lean();

  const out = [];
  for (const l of rows) {
    const item = makeActivityEntry(l);
    if (item) out.push(item);
  }
  return out;
}

// ===== REST: health / clients / jobs / logs =====
app.get("/health", (_req, res) => res.send("ok"));

app.get("/clients", async (_req, res) => {
  try {
    const snapshot = await buildPhaseSnapshotFromDB();
    const now = Date.now();
    const actives = [...clients.values()].map((c) => {
      const sum = snapshot[c.clientId || c.label || c.socketId] || {};
      return {
        ...c,
        statusSummary: {
          overall: sum.overall || "idle",
          lastJobId: sum.lastJobId,
          lastTs: sum.lastTs || 0,
          phases: sum.phases || {},
          onlineForSec: Math.round((now - c.connectedAt) / 1000),
          idleForSec: Math.round((now - (c.lastSeen || c.connectedAt)) / 1000),
        },
      };
    });
    res.json(actives);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/jobs", async (_req, res) => {
  try {
    const last = Date.now() - 7 * 24 * 3600 * 1000;
    const rows = await RealtimeLog.aggregate([
      { $match: { jobId: { $ne: null }, ts: { $gte: last } } },
      {
        $group: {
          _id: "$jobId",
          first: { $min: "$ts" },
          last: { $max: "$ts" },
        },
      },
      { $sort: { last: -1 } },
      { $limit: 500 },
    ]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// /logs: raw (DB) | view=activity (DB)
app.get("/logs", async (req, res) => {
  try {
    const {
      type,
      jobId,
      clientId,
      view,
      since,
      limit,
      sort = "asc",
    } = req.query;

    if (view === "activity") {
      const entries = await buildActivityLogsFromDB({
        since: since ? Number(since) : undefined,
        limit: limit ? Number(limit) : 200,
      });
      const nextSince = entries.length
        ? entries[entries.length - 1].ts
        : since
        ? Number(since)
        : Date.now();
      return res.json({ since: Number(since) || 0, nextSince, entries });
    }

    const q = {};
    if (type) q.type = type;
    if (jobId) q.jobId = jobId;
    if (clientId) q.$or = [{ clientId }, { label: clientId }];

    const rows = await RealtimeLog.find(q)
      .sort({ ts: sort === "desc" ? -1 : 1 })
      .limit(Math.min(Number(limit) || 200, 5000))
      .lean();

    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// SSE stream (bootstrap từ liveBuffer để realtime ngay)
app.get("/logs/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // bootstrap 50 sự kiện gần nhất từ liveBuffer
  const first = liveBuffer
    .slice(-50)
    .map((e) => {
      // map sang activity dòng đơn
      const fakeDoc = {
        ts: e.ts,
        type: e.type,
        phase: e.data?.phase,
        status: e.data?.status,
        socketId: e.data?.socketId,
        meta: e.data,
      };
      return makeActivityEntryFromDoc(fakeDoc);
    })
    .filter(Boolean);
  res.write(`data: ${JSON.stringify({ bootstrap: first })}\n\n`);

  const hb = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {}
  }, 15000);

  const client = { res, hb };
  sseClients.add(client);
  req.on("close", () => {
    clearInterval(hb);
    sseClients.delete(client);
    try {
      res.end();
    } catch {}
  });
});

// ===== Legacy: phát job test (giữ nguyên) =====
app.post("/run-now", (req, res) => {
  const jobId = String(Date.now());
  const reason = req.body?.reason || "manual";
  const payload = { jobId, reason };

  io.emit("RUN_JOB", payload);
  io.emit("RUN_NOW", { type: "RUN_NOW", ...payload });
  addLog("RUN_JOB", payload);
  addLog("RUN_NOW", payload);

  res.json({ ok: true, ...payload });
});

// ===== Admin APIs =====
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

app.post("/admin/run-now", (req, res) => {
  const jobId = String(Date.now());
  const reason = req.body?.reason || "manual";
  const payload = { type: "RUN_NOW", jobId, reason };
  io.emit("RUN_NOW", payload);
  addLog("RUN_NOW", payload);
  res.json({ ok: true, jobId, reason });
});

// Tóm tắt job (đọc DB)
app.get("/admin/job/:jobId", async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const events = await RealtimeLog.find({ jobId })
      .sort({ ts: 1 })
      .limit(5000)
      .lean();
    if (!events.length)
      return res.status(404).json({ ok: false, message: "job not found" });

    const ackSet = new Set(
      events
        .filter((e) => e.type === "ACK")
        .map((e) => e.clientId || e.label || e.socketId)
    );
    const phases = ["import", "report", "ads", "config"];
    const perClient = {};
    for (const ev of events) {
      if (ev.type !== "STATUS") continue;
      const cid = ev.clientId || ev.label || "unknown";
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

    const summary = {
      jobId,
      createdAt: events[0].ts,
      reason:
        events.find((e) => e.type === "RUN_NOW")?.meta?.reason || "unknown",
      ackCount: ackSet.size,
      acks: [...ackSet],
    };

    res.json({
      ok: true,
      summary,
      counts,
      perClient,
      events: events.slice(-200),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ===== Run Server =====
const PORT = process.env.PORT || 5000;
connectDB();
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🚀 HTTP + Socket.IO running at http://localhost:${PORT}  (path /socket)`
  );
});
