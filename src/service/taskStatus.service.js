const TaskStatusEvent = require("../models/taskStatusEvent.model");
const ExtensionTask = require("../models/extensionTask.model");
const AutoConfig = require("../models/autoConfig.model");

function compactAdsResult(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.days) || result.days.length > 31) return undefined;
  const days = result.days.map((item) => ({
    day: typeof item?.day === "string" ? item.day.slice(0, 10) : null,
    importedRows: Number.isFinite(item?.importedRows) ? item.importedRows : 0,
    sellersAffected: Number.isFinite(item?.sellersAffected) ? item.sellersAffected : 0,
    shopSpend: Number.isFinite(item?.shopSpend) ? item.shopSpend : 0,
    skipped: item?.skipped === true,
    message: typeof item?.message === "string" ? item.message.slice(0, 240) : "",
  }));
  return { startDate: String(result.startDate || "").slice(0, 10), endDate: String(result.endDate || "").slice(0, 10), days };
}

function compactUploadTrackingResult(result) {
  const upload = result?.upload;
  if (!upload || upload.ok !== true || !upload.batchId) return undefined;
  return {
    upload: {
      ok: true,
      batchId: String(upload.batchId),
      ordersCount: Number.isSafeInteger(upload.ordersCount) ? upload.ordersCount : 0,
    },
  };
}

async function upsertByEventId(payload) {
  const now = new Date();
  if (!payload || !payload.eventId) {
    throw new Error("eventId is required");
  }
  if (!payload.taskId) {
    throw new Error("taskId is required");
  }
  if (!payload.status) {
    throw new Error("status is required");
  }

  const result = payload.type === "IMPORT_ADS_SPEND"
    ? compactAdsResult(payload.result)
    : payload.type === "UPLOAD_TRACKING"
      ? compactUploadTrackingResult(payload.result)
      : undefined;
  let deduped = false;
  let doc;

  try {
    doc = await TaskStatusEvent.create({
      eventId: payload.eventId,
      taskId: payload.taskId,
      type: payload.type,
      status: payload.status,
      shopId: payload.shopId,
      machineId: payload.machineId,
      result,
      error: payload.error,
      source: payload.source || "unknown",
      reportedAt: payload.reportedAt ? new Date(payload.reportedAt) : now,
      rawPayload: payload.rawPayload || payload,
      firstSeenAt: now,
      lastSeenAt: now,
      duplicateCount: 0,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      deduped = true;
      doc = await TaskStatusEvent.findOneAndUpdate(
        { eventId: payload.eventId },
        {
          $set: { lastSeenAt: now, rawPayload: payload.rawPayload || payload },
          $inc: { duplicateCount: 1 },
        },
        { new: true }
      );
    } else {
      throw err;
    }
  }

  // Đồng bộ trạng thái sang ExtensionTask (best-effort)
  try {
    const update = { $set: {} };
    if (payload.status === "received") {
      update.$set.status = "received";
      update.$set.ackedAt = now;
    } else if (payload.status === "completed") {
      update.$set.status = "completed";
      update.$set.completedAt = now;
      if (result) update.$set.result = result;
    } else if (payload.status === "failed") {
      update.$set.status = "failed";
      update.$set.completedAt = now;
      if (payload.error) update.$set.lastError = payload.error;
    }
    if (Object.keys(update.$set).length > 0) {
      await ExtensionTask.updateOne({ taskId: payload.taskId }, update);
      const task = await ExtensionTask.findOne({ taskId: payload.taskId }).lean();
      const configId = task?.payload?.autoConfigId;
      if (configId) {
        const configUpdate = { lastTaskStatus: payload.status };
        if (payload.status === "completed" || payload.status === "failed") configUpdate.lastTaskFinishedAt = now;
        if (payload.status === "failed") configUpdate.lastTaskError = String(payload.error || "Task failed");
        await AutoConfig.updateOne({ _id: configId }, { $set: configUpdate });
      }
    }
  } catch (e) {
    console.error("[TASK_STATUS] sync ExtensionTask failed:", e.message);
  }

  return { deduped, doc };
}

async function findPendingTasks({ shopId, machineId, statuses, sentAfter }) {
  const q = {
    machineId,
    status: {
      $in: statuses && statuses.length ? statuses : ["sent", "received"],
    },
  };
  if (shopId) q.shopId = shopId;
  if (sentAfter) q.sentAt = { $gte: sentAfter };
  return ExtensionTask.find(q).sort({ createdAt: 1 }).limit(200).lean();
}

module.exports = { upsertByEventId, findPendingTasks };
