const express = require("express");
const router = express.Router();
const cronJobController = require("../controllers/cronJob.controller");

// Lấy trạng thái tất cả jobs
router.get("/status", cronJobController.getJobsStatus);

// Chạy job thủ công
router.post("/run/:jobName", cronJobController.runJobManually);

// Dừng job
router.post("/stop/:jobName", cronJobController.stopJob);

// Khởi động job
router.post("/start/:jobName", cronJobController.startJob);

module.exports = router;