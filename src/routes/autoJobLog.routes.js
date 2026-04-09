const express = require("express");
const router = express.Router();
const autoJobLogController = require("../controllers/autoJobLog.controller");

// GET /api/auto-job-logs - Lấy danh sách logs với phân trang và filter
router.get("/", autoJobLogController.getLogs);

// GET /api/auto-job-logs/stats - Lấy thống kê logs
router.get("/stats", autoJobLogController.getStats);

// GET /api/auto-job-logs/export - Export logs cho debugging
router.get("/export", autoJobLogController.exportLogs);

// GET /api/auto-job-logs/job/:jobId - Lấy logs theo job ID
router.get("/job/:jobId", autoJobLogController.getLogsByJobId);

// GET /api/auto-job-logs/:executionId - Lấy chi tiết một execution
router.get("/:executionId", autoJobLogController.getLogDetail);

// POST /api/auto-job-logs/cleanup - Xóa logs cũ (manual cleanup)
router.post("/cleanup", autoJobLogController.cleanupLogs);

module.exports = router;