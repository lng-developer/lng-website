// routes/psdTask.routes.js
const express = require("express");
const router = express.Router();
const { PsdTaskController } = require("../controllers");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// Lấy danh sách task
router.get("/", authenticateToken, PsdTaskController.getTasks);

router.get(
  "/statictisc",
  authenticateToken,
  PsdTaskController.getTaskStatistics
);

// Seller actions
router.post(
  "/request",
  authenticateToken,
  authorizeRoles("Admin", "Seller", "Design Leader"),
  PsdTaskController.requestPSD
);
router.post(
  "/:taskId/qc",
  authenticateToken,
  authorizeRoles("Admin", "Seller", "Design Leader"),
  PsdTaskController.qcPSD
);

// Leader actions
router.post(
  "/assign/bulk",
  authenticateToken,
  authorizeRoles("Admin", "Design Leader"),
  PsdTaskController.assignDesignerBulk
);

router.post(
  "/:taskId/assign",
  authenticateToken,
  authorizeRoles("Admin", "Design Leader"),
  PsdTaskController.assignDesigner
);

// Designer actions
router.post(
  "/:taskId/start",
  authenticateToken,
  authorizeRoles("Admin", "Designer", "Design Leader"),
  PsdTaskController.startTask
);
router.post(
  "/:taskId/upload",
  authenticateToken,
  authorizeRoles(
    "Admin",
    "Designer",
    "Seller",
    "Design Leader",
    "Customer Service"
  ),
  upload.single("file"),
  PsdTaskController.uploadPSD
);

router.delete(
  "/:taskId",
  authenticateToken,
  authorizeRoles("Admin", "Design Leader"),
  PsdTaskController.deletePsdTask
);

module.exports = router;
