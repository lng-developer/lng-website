const express = require("express");
const router = express.Router();
const extensionLogController = require("../controllers/extensionLog.controller");
const ExtensionLog = require("../models/extensionLog.model");

// POST /api/ext/logs - Extensions gửi logs lên server
router.post("/", extensionLogController.submitLog);

// GET /api/ext/logs/all - Lấy tất cả logs (admin)
router.get("/all", extensionLogController.getAllLogs);

// GET /api/ext/logs/task/:taskId - Lấy logs theo task ID
router.get("/task/:taskId", extensionLogController.getLogsByTask);

// GET /api/ext/logs/batch/:batchId - Lấy logs theo batch ID
router.get("/batch/:batchId", extensionLogController.getLogsByTask);

// GET /api/ext/logs/stats/:machineId - Lấy thống kê logs của extension
router.get("/stats/:machineId", extensionLogController.getLogStats);

// GET /api/ext/logs/:machineId - Lấy logs của extension cụ thể
router.get("/:machineId", extensionLogController.getLogs);

// DELETE /api/ext/logs/cleanup - Cleanup logs cũ
router.delete("/cleanup", extensionLogController.cleanupLogs);

// Auto xóa toàn bộ logs mỗi 1 ngày
setInterval(async () => {
  try {
    const result = await ExtensionLog.deleteMany({});
    console.log(`🧹 [EXT-LOG] Auto cleanup: deleted ${result.deletedCount} logs`);
  } catch (err) {
    console.error(`❌ [EXT-LOG] Auto cleanup failed: ${err.message}`);
  }
}, 24 * 60 * 60 * 1000);

module.exports = router;