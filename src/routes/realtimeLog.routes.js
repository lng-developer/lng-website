const express = require("express");
const { realtimeLogController } = require("../controllers");
const router = express.Router();
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");

router.get("/", realtimeLogController.getLogs);

router.post("/ext/log", realtimeLogController.addLog);

module.exports = router;
