const express = require("express");
const router = express.Router();
const scaleController = require("../controllers/scale.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticateToken);

router.post("/:orderId/items/:orderItemId/upload", upload.array("files"), scaleController.uploadFulfillmentFiles);
router.post("/:orderId/items/:orderItemId/confirm", scaleController.confirmScale);

module.exports = router;

