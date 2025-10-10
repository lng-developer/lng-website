/* Realtime (SSE + Socket emit) + helper build activity */
const db = require("../models");
const RealtimeLog = db.RealtimeLog;

let ioRef = null;
const setIo = (io) => {
  ioRef = io;
};

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

const phaseVi = (p) =>
  p === "import"
    ? "Import"
    : p === "report"
    ? "Import report"
    : p === "ads"
    ? "Ads"
    : p || "";
function formatExtras(d = {}) {
  const out = [];
  if (Number.isFinite(d.count)) out.push(`${d.count} orders`);
  if (Number.isFinite(d.created)) out.push(`created ${d.created}`);
  if (Number.isFinite(d.updated)) out.push(`updated ${d.updated}`);
  if (Number.isFinite(d.skipped)) out.push(`skip ${d.skipped}`);
  if (d.reportId) out.push(`report ${d.reportId}`);
  if (Number.isFinite(d.ms)) out.push(`${d.ms}ms`);
  return out.length ? ` (${out.join(", ")})` : "";
}
function makeActivityEntryFromDoc(l) {
  const d = l.meta || {};
  const label = d.label || d.clientId || "Unknown";
  if (l.type === "RUN_NOW")
    return {
      ts: l.ts,
      type: "info",
      text: "Start import now…",
      meta: { jobId: l.jobId },
    };
  if (l.type === "RUN_SCHEDULED")
    return {
      ts: l.ts,
      type: "info",
      text: `Scheduled job created @ ${new Date(
        l.meta?.dueAt || l.ts
      ).toLocaleTimeString("vi-VN")}`,
    };
  if (l.type === "SYNC_CONFIG")
    return {
      ts: l.ts,
      type: "success",
      text: d.enabled
        ? `Auto import enabled (fixed ${d.everyHours}h from ${d.baseHour}:00, tzOffset=${d.tzMin}m)`
        : "Auto import disabled",
    };
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
  }
  if (l.type === "CONNECT")
    return { ts: l.ts, type: "info", text: `Client ${l.socketId} connected` };
  if (l.type === "DISCONNECT")
    return { ts: l.ts, type: "info", text: `Client ${l.socketId} disconnect` };
  return null;
}

// ===== Quy tắc lưu DB: LƯU import/report/ads khi success|fail =====
function shouldPersist(type, data = {}) {
  if (type !== "STATUS") return false;
  const phase = String(data.phase || "").toLowerCase();
  const status = String(data.status || "").toLowerCase();
  // Lưu cả 3 phase: import, report, ads
  const tracked = ["import", "report", "ads"];
  return tracked.includes(phase) && (status === "success" || status === "fail");
}

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

  bufferAndPushSSE({ ts, type, data });
  ioRef?.emit("ADMIN_EVENT", { ts, type, data });
  const act = makeActivityEntryFromDoc({ ...evt, meta: data });
  if (act) ioRef?.emit("ADMIN_ACTIVITY", act);

  if (shouldPersist(type, data)) {
    try {
      await RealtimeLog.create({ ...evt, meta: data });
    } catch (e) {
      console.warn("[LOG-PERSIST]", e.message);
    }
  }
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

function sseStream(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const first = liveBuffer
    .slice(-50)
    .map((e) => {
      const fake = {
        ts: e.ts,
        type: e.type,
        phase: e.data?.phase,
        status: e.data?.status,
        socketId: e.data?.socketId,
        meta: e.data,
      };
      return makeActivityEntryFromDoc(fake);
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
}

module.exports = {
  setIo,
  addLog,
  buildActivityLogsFromDB,
  buildPhaseSnapshotFromDB,
  sseStream,
};
