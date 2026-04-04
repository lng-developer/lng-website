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

router.post("/update-all-fake", shippingBatchController.updateAllFakeTracking);

router.get(
  "/download-all-updated",
  shippingBatchController.downloadAllUpdatedFakeFile
);

// ✅ Route mới: Export orders có tracking trực tiếp
router.post(
  "/export-orders-with-tracking",
  shippingBatchController.exportOrdersWithTracking
);

// ✅ Route mới: Kiểm tra trạng thái orders
router.get(
  "/check-orders-status",
  shippingBatchController.checkOrdersStatus
);

module.exports = router;
