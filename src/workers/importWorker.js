const path = require("path");
const fs = require("fs");
const Redis = require("ioredis");

// queue
const importQueue = require("../queues/importQueue");

// the processor from your controller (must export updateOrdersFromXlsxProcessor)
const {
  updateOrdersFromXlsxProcessor,
} = require("../controllers/order.controller");

// socket.io emitter for broadcasting to Socket.IO server(s)
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redisClientForEmitter = new Redis(redisUrl);

// socket.io-emitter will publish to Redis, and server(s) with socket.io-redis adapter
// will deliver to connected clients
let ioEmitter = null;
try {
  // require socket.io-emitter lazily so package missing error clearer
  // npm i socket.io-emitter
  const socketioEmitter = require("socket.io-emitter");
  ioEmitter = socketioEmitter(redisClientForEmitter);
} catch (e) {
  console.warn("[importWorker] socket.io-emitter not available:", e.message);
  ioEmitter = null;
}

// helper to emit safely
function emitSafe(evt, payload) {
  try {
    if (ioEmitter) ioEmitter.emit(evt, payload);
  } catch (e) {
    console.warn("[importWorker] emit error", e.message);
  }
}

// process jobs
const CONCURRENCY = Number(process.env.IMPORT_WORKER_CONCURRENCY || 1);

console.log(
  "[importWorker] starting, concurrency=",
  CONCURRENCY,
  "REDIS=",
  redisUrl
);

importQueue.process(CONCURRENCY, async (job, done) => {
  const jobId = job.id;
  const data = job.data || {};
  const { filePath, originalname, body } = data;

  console.log(`[importWorker] job start ${jobId} file=${filePath}`);

  // emit start
  emitSafe("import:started", {
    jobId,
    at: Date.now(),
    shopId: body?.shopId || null,
    machineId: body?.machineId || null,
    file: path.basename(filePath || originalname || "upload"),
  });

  // Optionally update job progress
  try {
    // If updateOrdersFromXlsxProcessor supports step callbacks, you can push progress here.
    // We'll simply call it and emit before/after.
    const result = await updateOrdersFromXlsxProcessor({
      filePath,
      originalname,
      body,
    });

    // Emit success
    emitSafe("import:done", {
      jobId,
      at: Date.now(),
      shopId: body?.shopId || null,
      machineId: body?.machineId || null,
      result,
    });

    console.log(`[importWorker] job done ${jobId}`);
    done(null, result);
  } catch (err) {
    console.error(`[importWorker] job error ${jobId}`, err?.message || err);

    // Emit failure
    emitSafe("import:failed", {
      jobId,
      at: Date.now(),
      shopId: body?.shopId || null,
      machineId: body?.machineId || null,
      error: String(err?.message || err),
    });

    // ensure temporary file cleaned
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_) {}

    done(err);
  }
});

// graceful shutdown for PM2
process.on("SIGINT", async () => {
  console.log("[importWorker] SIGINT received, shutting down...");
  try {
    await importQueue.close();
    await redisClientForEmitter.quit();
  } catch (_) {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("[importWorker] SIGTERM received, shutting down...");
  try {
    await importQueue.close();
    await redisClientForEmitter.quit();
  } catch (_) {}
  process.exit(0);
});
