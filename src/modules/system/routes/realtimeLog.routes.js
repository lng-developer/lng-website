const express = require("express");
const realtimeLogController = require("../controllers/realtimeLog.controller");
const router = express.Router();

router.post("/add", realtimeLogController.addLog);
router.post("/append", realtimeLogController.appendLogs);
router.get("/", realtimeLogController.getListLog);

module.exports = router;

