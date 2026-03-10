const express = require("express");
const router = express.Router();
const caseRoutes = require("./case.routes");
const psdTaskRoutes = require("./psdTask.routes");
const ideaTaskRoutes = require("./ideaTask.routes");

router.use("/api/case", caseRoutes);
router.use("/api/psd-task", psdTaskRoutes);
router.use("/api/idea-task", ideaTaskRoutes);

module.exports = router;

