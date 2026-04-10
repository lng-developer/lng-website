const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { shippingBatchController } = require("../controllers");

// ✅ Debug endpoint
// const { debugSocketRooms } = require("../../debug-socket-rooms");
// router.get("/debug/socket-rooms", debugSocketRooms);

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

// COMMENTED OUT - removed fake tracking logic
// router.post("/update-all-fake", shippingBatchController.updateAllFakeTracking);

// COMMENTED OUT - removed fake tracking logic
// router.get(
//   "/download-all-updated",
//   shippingBatchController.downloadAllUpdatedFakeFile
// );

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

// ✅ Route mới: FE gửi task UPLOAD_TRACKING thủ công
router.post(
  "/manual-upload-task",
  shippingBatchController.manualUploadTask
);

// ✅ Route mới: FE lấy danh sách batch có thể upload
router.get(
  "/uploadable",
  shippingBatchController.getUploadableBatches
);

// ✅ Route mới: FE tạo batch từ danh sách orders
router.post(
  "/create-from-orders",
  shippingBatchController.createBatchFromOrders
);

// ✅ Route mới: Auto upload tracking
router.post(
  "/auto-upload-tracking",
  shippingBatchController.autoUploadTracking
);

// ✅ Route mới: Debug auto upload tracking với logs chi tiết
router.post(
  "/debug-auto-upload-tracking",
  shippingBatchController.debugAutoUploadTracking
);

module.exports = router;
