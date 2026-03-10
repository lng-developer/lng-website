const express = require("express");
const router = express.Router();
const shippingBatchController = require("../controllers/shippingBatch.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticateToken);

router.post("/create", upload.single("file"), shippingBatchController.createBatchFromFile);
router.get("/", shippingBatchController.listShippingBatches);
router.post("/:batchId/update", shippingBatchController.createUpdateBatchFromSystem);
router.get("/:batchId/download", shippingBatchController.downloadCompletedFile);
router.post("/update-fake", shippingBatchController.updateAllFakeTracking);
router.get("/download-fake", shippingBatchController.downloadAllUpdatedFakeFile);

module.exports = router;

