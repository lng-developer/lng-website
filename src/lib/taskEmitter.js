const ExtensionTask = require("../models/extensionTask.model");

function safeKey(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function todayStr() {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

/**
 * Build a stable taskId by task type.
 * Format: <type_lower>:<shopId>:<key>
 *   - IMPORT_ORDERS / IMPORT_FBM_ORDERS -> payload.date || todayStr()
 *   - IMPORT_ADS_SPEND -> payload.date || todayStr()
 *   - SYNC_ETSY_LISTINGS / ETSY_SYNC_LISTINGS -> payload.date || payload.mode || todayStr()
 *   - ETSY_UPLOAD_TRACKING / UPLOAD_TRACKING -> payload.batchId || orderId_trackingNumber || Date.now()
 *   - Unknown type -> timestamp, not idempotent
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
    case "SYNC_ETSY_LISTINGS":
    case "ETSY_SYNC_LISTINGS":
      key = safeKey(payload?.date || payload?.mode || todayStr());
      break;
    case "ETSY_UPLOAD_TRACKING":
    case "UPLOAD_TRACKING":
      key = safeKey(
        payload?.batchId ||
        [payload?.orderId, payload?.trackingNumber].filter(Boolean).join("_") ||
        Date.now()
      );
      break;
    default:
      key = String(Date.now());
  }

  return `${t}:${s}:${key}`;
}

/**
 * Persist and send a task to one machine so it can be resent after reconnect.
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
