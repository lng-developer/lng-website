// // src/queues/importQueue.js
// // BullMQ version (NOT bull)
// // npm i bullmq ioredis

// const { Queue, QueueEvents } = require("bullmq");
// const IORedis = require("ioredis");

// const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// // Bạn có thể truyền vào BullMQ một IORedis instance
// const connection = new IORedis(redisUrl, {
//   // optional hardening
//   maxRetriesPerRequest: null,
//   enableReadyCheck: true,
// });

// // Tạo Queue (chỉ dùng để add job)
// const importQueue = new Queue("import-jobs", { connection });

// // Tạo QueueEvents để lắng nghe completed/failed (không block)
// const importQueueEvents = new QueueEvents("import-jobs", { connection });

// // Bắt events (debug/log)
// importQueueEvents.on("error", (err) => {
//   console.error("[importQueueEvents] error:", err);
// });

// importQueueEvents.on("completed", ({ jobId, returnvalue }) => {
//   console.log("[importQueueEvents] completed:", jobId);
//   // returnvalue là JSON string ở BullMQ v4 (tùy worker set)
//   // console.log("result:", returnvalue);
// });

// importQueueEvents.on("failed", ({ jobId, failedReason }) => {
//   console.warn("[importQueueEvents] failed:", jobId, failedReason);
// });

// // Helper: add job vào queue
// // name: tên job (ví dụ: "update-from-xlsx")
// // data: payload đầu vào
// // opts: attempts/backoff/removal...
// async function addImportJob(name, data, opts = {}) {
//   return importQueue.add(name, data, {
//     attempts: 2,
//     backoff: { type: "exponential", delay: 5000 },
//     removeOnComplete: 50,
//     removeOnFail: 50,
//     ...opts,
//   });
// }

// module.exports = {
//   importQueue,
//   importQueueEvents,
//   addImportJob,
//   connection, // export luôn nếu worker cần tái sử dụng connection
// };
