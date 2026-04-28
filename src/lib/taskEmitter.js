const ExtensionTask = require("../models/extensionTask.model");

function safeKey(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function todayStr() {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

/**
 * Sinh taskId cố định theo type. Cùng input → cùng taskId (idempotent).
 * Format: <type_lower>:<shopId>:<key>
 *   - IMPORT_ORDERS / IMPORT_FBM_ORDERS         → key = date (YYYY-MM-DD)
 *   - IMPORT_ADS_SPEND                          → key = payload.date || yesterday
 *   - UPLOAD_TRACKING                           → key = batchId
 *   - Khác                                      → key = timestamp ms (không idempotent)
 */
function buildTaskId({ type, shopId, machineId, payload }) {
  const t = String(type || "TASK").toLowerCase();
  const s = safeKey(shopId || machineId || "global");

  let key;
  switch (String(type || "").toUpperCase()) {
    case "IMPORT_ORDERS":
    case "IMPORT_FBM_ORDERS":
      key = safeKey(payload?.date || todayStr());
      break;
    case "IMPORT_ADS_SPEND":
      key = safeKey(payload?.date || todayStr());
      break;
    case "UPLOAD_TRACKING":
      key = safeKey(payload?.batchId || Date.now());
      break;
    default:
      key = String(Date.now());
  }

  return `${t}:${s}:${key}`;
}

/**
 * Gửi task tới 1 machine + lưu DB để có thể resend khi extension reconnect.
 * Trả về object task message đã emit.
 */
async function emitTaskToMachine(io, { taskId, type, shopId, machineId, payload }) {
  if (!io) throw new Error("io required");
  if (!machineId) throw new Error("machineId required");
  if (!type) throw new Error("type required");

  const finalTaskId =
    taskId || buildTaskId({ type, shopId, machineId, payload });

  const taskMessage = {
    taskId: finalTaskId,
    type,
    payload: { ...(payload || {}), taskId: finalTaskId },
    sentAt: new Date().toISOString(),
  };

  try {
    await ExtensionTask.findOneAndUpdate(
      { taskId: finalTaskId },
      {
        $set: {
          taskId: finalTaskId,
          type,
          shopId: shopId || null,
          machineId: String(machineId),
          payload: taskMessage.payload,
          status: "sent",
          sentAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (e) {
    console.error(`[TASK_EMIT] persist failed for ${finalTaskId}:`, e.message);
  }

  io.to(`machine:${machineId}`).emit("server:task", taskMessage);
  return taskMessage;
}

module.exports = { buildTaskId, emitTaskToMachine };
