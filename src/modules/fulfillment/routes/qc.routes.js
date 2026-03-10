const express = require("express");
const router = express.Router();
const qcController = require("../controllers/qc.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");

router.use(authenticateToken);

router.get("/", qcController.getQCList);
router.get("/stats", qcController.getQCStatistics);
router.put("/:orderId/items/:orderItemId/note", qcController.updateQCNoteForItem);

module.exports = router;

