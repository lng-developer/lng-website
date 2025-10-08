const express = require("express");
const { realtimeLogController } = require("../controllers");
const router = express.Router();
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");

router.get(
  "/",
  authenticateToken,
  authorizeRoles("Admin"),
  realtimeLogController.getLogs
);

module.exports = router;
