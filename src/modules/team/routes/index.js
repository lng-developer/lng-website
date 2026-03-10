const express = require("express");
const router = express.Router();
const teamRoutes = require("./team.routes");

router.use("/api/teams", teamRoutes);

module.exports = router;

