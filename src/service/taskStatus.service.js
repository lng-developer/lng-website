const TaskStatusEvent = require("../models/taskStatusEvent.model");
const ExtensionTask = require("../models/extensionTask.model");
const AutoConfig = require("../models/autoConfig.model");

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
      result: payload.result,
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

async function findPendingTasks({ shopId, machineId, statuses }) {
  const q = {
    machineId,
    status: {
      $in: statuses && statuses.length ? statuses : ["sent", "received"],
    },
  };
  if (shopId) q.shopId = shopId;
  return ExtensionTask.find(q).sort({ createdAt: 1 }).limit(200).lean();
}

module.exports = { upsertByEventId, findPendingTasks };
