const express = require("express");
const { scaleController } = require("../controllers");
const router = express.Router();
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");

router.post(
  "/orders/:orderId/items/:orderItemId/fulfillment-file",
  authenticateToken,
  // authorizeRoles(
  //   "Customer Service",
  //   "Admin",
  //   "Seller",
  //   "Designer",
  //   "Design Leader"
  // ),
  scaleController.uploadFulfillmentFileForItem
);

// Xác nhận per item (approve/reject) + auto-send khi đủ
router.post(
  "/orders/:orderId/items/:orderItemId/scale/confirm",
  authenticateToken,
  authorizeRoles("Customer Service", "Admin", "Seller"),
  scaleController.confirmScaleForItem
);

// (Tuỳ chọn) Retry gửi toàn bộ order khi Ready/Failed
router.post(
  "/orders/:orderId/scale/send",
  authenticateToken,
  authorizeRoles("Customer Service", "Admin", "Seller"),
  scaleController.retrySendGrabink
);

router.put(
  "/orders/:orderId/items/:orderItemId/cs-note",
  authenticateToken,
  authorizeRoles("Customer Service", "Admin", "Seller"),
  scaleController.updateCSNoteForItem
);

router.get(
  "/list",
  authenticateToken,
  authorizeRoles(
    "Customer Service",
    "Admin",
    "Seller",
    "Design Leader",
    "Designer"
  ),
  scaleController.getScaleList
);

router.get(
  "/statistics",
  authenticateToken,
  authorizeRoles(
    "Customer Service",
    "Admin",
    "Seller",
    "Design Leader",
    "Designer"
  ),
  scaleController.getScaleStatistics
);

router.get(
  "/list/design",
  authenticateToken,
  authorizeRoles(
    "Customer Service",
    "Admin",
    "Seller",
    "Designer",
    "Design Leader"
  ),
  scaleController.getScaleListForDesign
);

router.get(
  "/statistics/design",
  authenticateToken,
  authorizeRoles(
    "Customer Service",
    "Admin",
    "Seller",
    "Designer",
    "Design Leader"
  ),
  scaleController.getScaleStatisticsForDesign
);

router.put(
  "/orders/reset/bulk",
  scaleController.resetScaleForOrdersBulk
);

router.put(
  "/orders/assign-scale/bulk",
  authenticateToken,
  authorizeRoles("Admin", "Design Leader"),
  scaleController.assignScaleBulk
);

router.put(
  "/orders/:orderId/assign-cs",
  authenticateToken,
  authorizeRoles("Admin", "Design Leader"),
  scaleController.assignOrderToCS
);
module.exports = router;
