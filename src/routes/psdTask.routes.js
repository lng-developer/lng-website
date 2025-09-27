// routes/psdTask.routes.js
const express = require("express");
const router = express.Router();
const { PsdTaskController } = require("../controllers");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");

// Lấy danh sách task
router.get("/", authenticateToken, PsdTaskController.getTasks);

// Seller actions
router.post(
  "/request",
  authenticateToken,
  authorizeRoles("Admin", "Seller"),
  PsdTaskController.requestPSD
);
router.post(
  "/:taskId/qc",
  authenticateToken,
  authorizeRoles("Admin", "Seller"),
  PsdTaskController.qcPSD
);

// Leader actions
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
  authorizeRoles("Admin", "Designer"),
  PsdTaskController.startTask
);
router.post(
  "/:taskId/upload",
  authenticateToken,
  authorizeRoles("Admin", "Designer", "Seller"),
  PsdTaskController.uploadPSD
);

module.exports = router;
