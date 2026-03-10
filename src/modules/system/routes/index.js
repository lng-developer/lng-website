const express = require("express");
const router = express.Router();
const adminSessionRoutes = require("./adminSession.routes");
const auditLogRoutes = require("./auditLog.routes");
const configCostCenterRoutes = require("./configCostCenter.routes");
const configOptionMappingRoutes = require("./configOptionMapping.routes");
const extRoutes = require("./ext.routes");
const pointsRoutes = require("./points.routes");
const realtimeRoutes = require("./realtime.routes");
const realtimeLogRoutes = require("./realtimeLog.routes");
const todoListRoutes = require("./todoList.routes");

router.use("/api/admin", adminSessionRoutes);
router.use("/api/audit-logs", auditLogRoutes);
router.use("/api/config-cost-center", configCostCenterRoutes);
router.use("/api/mapping", configOptionMappingRoutes);
router.use("/api/ext", extRoutes);
router.use("/api/points", pointsRoutes);
router.use("/api/realtime", realtimeRoutes);
router.use("/api/logs", realtimeLogRoutes);
router.use("/api/to-do", todoListRoutes);

module.exports = router;

