const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { shippingBatchController } = require("../controllers");

router.post(
  "/",
  upload.single("file"),
  shippingBatchController.createBatchFromFile
);
router.get("/", shippingBatchController.listShippingBatches);
router.post(
  "/:batchId/update-from-system",
  shippingBatchController.createUpdateBatchFromSystem
);
router.get("/:batchId/download", shippingBatchController.downloadCompletedFile);

module.exports = router;
