<<<<<<< Updated upstream:src/service/psdTask/psdTask.js
// services/psdTask.service.js
const PsdTask = require("../../models/psdTask.model");
=======
const PsdTask = require("../models/psdTask.model");
>>>>>>> Stashed changes:src/modules/task/services/psdTask.service.js

async function changeStatus(taskId, toStatus, by, action, note, extra = {}) {
  const task = await PsdTask.findById(taskId);
  if (!task) throw new Error("Task not found");

  const fromStatus = task.status;
  task.status = toStatus;

  if (toStatus === "QC Rejected") {
    task.revisionCount += 1;
  }
  if (extra.designer) task.designer = extra.designer;
  if (extra.priority) task.priority = extra.priority;
  if (extra.difficulty) task.difficulty = extra.difficulty;
  if (extra.dueAt) task.dueAt = extra.dueAt;

  task.history.push({
    by,
    from: fromStatus,
    to: toStatus,
    action,
    note,
  });

  await task.save();
  return task;
}

async function uploadFile(taskId, fileData, by) {
  const task = await PsdTask.findById(taskId);
  if (!task) throw new Error("Task not found");

  task.status = "Uploaded";
  task.files.push({ ...fileData, by });
  task.history.push({
    by,
    from: task.status,
    to: "Uploaded",
    action: "upload",
  });

  return task.save();
}

module.exports = {
  changeStatus,
  uploadFile,
};
