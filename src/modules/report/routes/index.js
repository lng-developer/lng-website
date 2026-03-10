const express = require("express");
const router = express.Router();
const reportRoutes = require("./report.routes");
const adsRoutes = require("./ads.routes");

router.use("/api/report", reportRoutes);
router.use("/api/ads", adsRoutes);

module.exports = router;

