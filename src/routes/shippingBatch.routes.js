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
  "/shipping-batches/:batchId/update-from-system",
  shippingBatchController.createUpdateBatchFromSystem
);

module.exports = router;
