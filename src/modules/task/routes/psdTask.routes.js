const express = require("express");
const router = express.Router();
const psdTaskController = require("../controllers/psdTask.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");
const multer = require("multer");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

router.use(authenticateToken);

router.get("/", psdTaskController.getTasks);
router.get("/stats", psdTaskController.getTaskStatistics);
router.post("/request", psdTaskController.requestPSD);
router.post("/:taskId/assign", psdTaskController.assignDesigner);
router.post("/:taskId/start", psdTaskController.startTask);
router.post("/:taskId/upload", upload.single("file"), psdTaskController.uploadPSD);
router.post("/:taskId/qc", psdTaskController.qcPSD);
router.delete("/:taskId", psdTaskController.deletePsdTask);

module.exports = router;

