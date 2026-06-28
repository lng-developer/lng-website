const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { shippingBatchController } = require("../controllers");
const { authenticateToken } = require("../middlewares/auth.middleware");

// ✅ Debug endpoint
// const { debugSocketRooms } = require("../../debug-socket-rooms");
// router.get("/debug/socket-rooms", debugSocketRooms);

router.post(
  "/",
  authenticateToken,
  upload.single("file"),
  shippingBatchController.createBatchFromFile
);
router.get("/", shippingBatchController.listShippingBatches);
router.post(
  "/:batchId/update-from-system",
  authenticateToken,
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
  authenticateToken,
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
  authenticateToken,
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
  authenticateToken,
  shippingBatchController.createBatchFromOrders
);

module.exports = router;
