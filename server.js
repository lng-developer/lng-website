/* eslint-disable no-console */
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

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
  realtimeLogRoutes,
} = require("./src/routes");

const db = require("./src/models");
const RealtimeLog = db.RealtimeLog;

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(morgan("dev"));
app.use(cors());

app.get("/", (_req, res) =>
  res.json({ message: "Welcome to RESTful API - Node.js" })
);

// APIs (giữ nguyên)
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
app.use("/api/logs", realtimeLogRoutes);
app.use("/admin/session", require("./src/routes/admin.session.routes"));

app.use((err, _req, res, _next) => {
  res
    .status(err.status || 500)
    .json({ error: { message: err.message || "Internal Server Error" } });
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

// ======= State nhẹ =======
const clients = new Map();

// ---- SSE + live buffer (hiển thị realtime) ----
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
  if (liveBuffer.length > LIVE_MAX)
    liveBuffer.splice(0, liveBuffer.length - LIVE_MAX);
  pushSSE(evt);
}

// ====== Helper: build activity 1 dòng từ document (rút gọn) ======
const phaseVi = (p) =>
  p === "import"
    ? "Import"
    : p === "report"
    ? "Import report"
    : p === "ads"
    ? "Ads"
    : p || "";

function formatExtras(d = {}) {
  const parts = [];
  if (Number.isFinite(d.count)) parts.push(`${d.count} orders`);
  if (Number.isFinite(d.created)) parts.push(`created ${d.created}`);
  if (Number.isFinite(d.updated)) parts.push(`updated ${d.updated}`);
  if (Number.isFinite(d.skipped)) parts.push(`skip ${d.skipped}`);
  if (d.file) parts.push(`file ${d.file}`);
  if (d.reportId) parts.push(`report ${d.reportId}`);
  if (Number.isFinite(d.ms)) parts.push(`${d.ms}ms`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function makeActivityEntryFromDoc(l) {
  const d = l.meta || {};
  const label = d.label || d.clientId || "Unknown";

  if (l.type === "RUN_NOW") {
    return {
      ts: l.ts,
      type: "info",
      text: "Start import orders...",
      meta: { jobId: l.jobId },
    };
  }
  if (l.type === "RUN_SCHEDULED") {
    return {
      ts: l.ts,
      type: "info",
      text: "Scheduled import tick",
      meta: { jobId: l.jobId },
    };
  }
  if (l.type === "STATUS") {
    const phaseName = phaseVi(l.phase);
    if (l.status === "success")
      return {
        ts: l.ts,
        type: "success",
        text: `${label}: ${phaseName} success${formatExtras(d)}`,
      };
    if (l.status === "fail")
      return {
        ts: l.ts,
        type: "error",
        text: `${label}: Error in ${phaseName}${
          l.error ? ` — ${l.error}` : ""
        }${formatExtras(d)}`,
      };
    return null; // start chỉ dùng realtime
  }
  if (l.type === "SYNC_CONFIG") {
    if (d.enabled === true) {
      if (d.mode === "fixed") {
        return {
          ts: l.ts,
          type: "success",
          text: `Auto import enabled (fixed every ${d.everyHours}h from ${d.baseHour}:00)`,
        };
      }
      const hours = d.intervalMin
        ? Math.round(d.intervalMin / 60)
        : (d.intervalMs / 3600000).toFixed(1);
      return {
        ts: l.ts,
        type: "success",
        text: `Auto import enabled (every ${hours || "?"} hours)`,
      };
    }
    if (d.enabled === false)
      return { ts: l.ts, type: "success", text: "Auto import disabled" };
  }
  if (l.type === "CONNECT")
    return { ts: l.ts, type: "info", text: `Client ${l.socketId} connected` };
  if (l.type === "DISCONNECT")
    return { ts: l.ts, type: "info", text: `Client ${l.socketId} disconnect` };
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

// ===== addLog: push realtime + (có điều kiện) lưu DB =====
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

  socket.on("HELLO", async (info) => {
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

    // Khi client online lại: nếu tick gần nhất chưa có import success/fail → phát RUN_NOW (catch-up)
    try {
      await maybeEmitCatchUp();
    } catch {}
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

// ===== SSE stream (bootstrap từ liveBuffer) =====
app.get("/logs/stream", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const first = liveBuffer
    .slice(-50)
    .map((e) => {
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
  res.on("close", () => {
    clearInterval(hb);
    sseClients.delete(client);
    try {
      res.end();
    } catch {}
  });
});

// ===== REST: health / clients / jobs / logs =====
app.get("/health", (_req, res) => res.send("ok"));

// (rút gọn: bạn có thể giữ nguyên 2 hàm buildPhaseSnapshotFromDB và /clients, /jobs, /logs như bản trước của bạn)
// Để tránh câu trả lời quá dài, các route /clients, /jobs, /logs bạn copy nguyên từ bản đang chạy (không đổi).

// ========== FIXED SCHEDULER (server-side) ==========
const scheduler = {
  enabled: false,
  mode: "fixed", // "fixed" (0,4,8...) hoặc "interval" (tương thích cũ)
  everyHours: Number(process.env.FIXED_EVERY_HOURS || 4),
  baseHour: Number(process.env.FIXED_BASE_HOUR || 0), // 0h mặc định
  timer: null,
  lastTickTs: 0,
};

// Tính mốc kế tiếp theo giờ máy (local)
function nextAlignedTs(fromTs = Date.now()) {
  const d = new Date(fromTs);
  d.setMinutes(0, 0, 0); // tròn giờ
  let h = d.getHours();
  const { baseHour, everyHours } = scheduler;
  const mod = (((h - baseHour) % everyHours) + everyHours) % everyHours;
  if (mod !== 0 || fromTs > d.getTime()) {
    // chuyển tới giờ tiếp theo trùng lớp
    h = h + (everyHours - mod);
    d.setHours(h, 0, 0, 0);
  }
  if (d.getTime() <= fromTs) d.setHours(d.getHours() + everyHours, 0, 0, 0);
  return d.getTime();
}

async function fireScheduledTick(reason = "schedule") {
  const jobId = String(Date.now());
  const payload = { type: "RUN_NOW", jobId, reason };
  addLog("RUN_SCHEDULED", {
    jobId,
    reason,
    schedule: {
      mode: scheduler.mode,
      baseHour: scheduler.baseHour,
      everyHours: scheduler.everyHours,
    },
  });
  io.emit("RUN_NOW", payload);
  addLog("RUN_NOW", payload);
  scheduler.lastTickTs = Date.now();
}

// Nếu mốc gần nhất chưa có import success/fail → phát lại
async function maybeEmitCatchUp() {
  if (!scheduler.enabled) return;
  // Lấy mốc lịch gần nhất (theo căn bậc)
  const prevTs = (() => {
    const now = Date.now();
    const next = nextAlignedTs(now);
    // mốc trước đó
    return next - scheduler.everyHours * 3600 * 1000;
  })();

  // kiểm tra có bản ghi import success/fail sau mốc đó chưa
  const ok = await RealtimeLog.findOne({
    type: "STATUS",
    phase: "import",
    status: { $in: ["success", "fail"] },
    ts: { $gte: prevTs },
  }).lean();

  if (!ok) {
    // chưa có ai chạy → phát lại 1 lần
    await fireScheduledTick("catch-up");
  }
}

function scheduleStart() {
  if (!scheduler.enabled || scheduler.timer) return;
  const plan = () => {
    const nextTs = nextAlignedTs();
    const delay = Math.max(1000, nextTs - Date.now());
    scheduler.timer = setTimeout(async () => {
      scheduler.timer = null;
      await fireScheduledTick("schedule");
      plan(); // loop
    }, delay);
    console.log(
      `[SCHEDULER] next tick at ${new Date(nextTs).toLocaleString()}`
    );
  };
  plan();
}

function scheduleStop() {
  if (scheduler.timer) {
    clearTimeout(scheduler.timer);
    scheduler.timer = null;
  }
}

// ----- Admin APIs -----
app.post("/admin/run-now", (req, res) => {
  const jobId = String(Date.now());
  const reason = req.body?.reason || "manual";
  const payload = { type: "RUN_NOW", jobId, reason };
  io.emit("RUN_NOW", payload);
  addLog("RUN_NOW", payload);
  res.json({ ok: true, jobId, reason });
});

/**
 * Bật/tắt lịch
 * Body hỗ trợ:
 *  - { enabled: true }  → bật fixed 4h (mặc định) bắt đầu từ baseHour=0
 *  - { enabled: true, mode:"fixed", everyHours, baseHour }
 *  - { enabled: false }
 * (Giữ tương thích cũ: nếu gửi intervalMin/intervalMs thì chỉ log lại, nhưng lịch chạy vẫn fixed.)
 */
app.post("/admin/schedule", async (req, res) => {
  const { enabled } = req.body || {};
  if (enabled === true) {
    const every = Number.isFinite(req.body?.everyHours)
      ? Number(req.body.everyHours)
      : scheduler.everyHours;
    const base = Number.isFinite(req.body?.baseHour)
      ? Number(req.body.baseHour)
      : scheduler.baseHour;
    scheduler.enabled = true;
    scheduler.mode = "fixed";
    scheduler.everyHours = Math.max(1, every);
    scheduler.baseHour = Math.min(23, Math.max(0, base));
    scheduleStop();
    scheduleStart();

    await RealtimeLog.create({
      ts: Date.now(),
      type: "SYNC_CONFIG",
      meta: {
        enabled: true,
        mode: "fixed",
        everyHours: scheduler.everyHours,
        baseHour: scheduler.baseHour,
      },
      day: new Date().toISOString().slice(0, 10),
    });

    addLog("SYNC_CONFIG", {
      enabled: true,
      mode: "fixed",
      everyHours: scheduler.everyHours,
      baseHour: scheduler.baseHour,
    });
    return res.json({
      ok: true,
      payload: {
        enabled: true,
        mode: "fixed",
        everyHours: scheduler.everyHours,
        baseHour: scheduler.baseHour,
      },
    });
  }

  // disable
  scheduler.enabled = false;
  scheduleStop();
  await RealtimeLog.create({
    ts: Date.now(),
    type: "SYNC_CONFIG",
    meta: { enabled: false },
    day: new Date().toISOString().slice(0, 10),
  });
  addLog("SYNC_CONFIG", { enabled: false });
  return res.json({ ok: true, payload: { enabled: false } });
});

// ===== Run Server =====
const PORT = process.env.PORT || 5000;
connectDB();
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🚀 HTTP + Socket.IO running at http://localhost:${PORT} (path /socket)`
  );
  if (process.env.AUTO_START_FIXED === "1") {
    scheduler.enabled = true;
    scheduleStart();
  }
});
