const router = require("express").Router();
const { jobController } = require("../controllers");

router.post("/claim", jobController.claim);
router.post("/complete", jobController.complete);

module.exports = router;
