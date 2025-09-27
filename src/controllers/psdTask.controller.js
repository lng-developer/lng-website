// controllers/psdTask.controller.js
const db = require("../models");
const PsdTask = db.PsdTask;
const psdTaskService = require("../service/psdTask/psdTask.js");

// GET list
const getTasks = async (req, res) => {
  try {
    const { status, seller, designer, page = 1, perPage = 10 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (seller) filter.seller = seller;
    if (designer) filter.designer = designer;

    const tasks = await PsdTask.find(filter)
      .populate("seller designer leader listing")
      .skip((page - 1) * perPage)
      .limit(Number(perPage));

    const total = await PsdTask.countDocuments(filter);
    res.json({ total, tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

async function requestPSD(req, res) {
  try {
    const { taskId } = req.body;
    const task = await PsdTask.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    if (task.status !== "New")
      return res.status(409).json({ message: "Only 'New' can be requested" });

    task.history.push({
      at: new Date(),
      by: req.user.userId,
      action: "seller_request",
      from: "New",
      to: "Requested",
      note: req.body?.note || "",
    });
    task.status = "Requested";
    await task.save();

    res.json(task);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST assign (leader)
const assignDesigner = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { designer, priority, dueAt } = req.body;

    const task = await psdTaskService.changeStatus(
      taskId,
      "Assigned",
      req.user.userId,
      "assign",
      null,
      { designer, priority, dueAt }
    );
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST start (designer)
const startTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await psdTaskService.changeStatus(
      taskId,
      "In Progress",
      req.user.userId,
      "start"
    );
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST upload file
const uploadPSD = async (req, res) => {
  try {
    const { taskId } = req.params;
    const fileData = {
      kind: "psd",
      url: req.body.url, // giả định đã upload lên cloudinary/wasabi trước
      version: Date.now(),
    };
    const task = await psdTaskService.uploadFile(
      taskId,
      fileData,
      req.user.userId
    );
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST QC
const qcPSD = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { result, note } = req.body;
    const status = result === "pass" ? "QC Passed" : "QC Rejected";
    const task = await psdTaskService.changeStatus(
      taskId,
      status,
      req.user.userId,
      "qc",
      note
    );
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getTasks,
  requestPSD,
  assignDesigner,
  startTask,
  uploadPSD,
  qcPSD,
};
