const router = require("express").Router();
const { adminController } = require("../controllers");
router.post("/run-now", adminController.runNow);
router.post("/schedule", adminController.schedule);

module.exports = router;
