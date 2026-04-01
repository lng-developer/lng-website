const express = require("express");
const router = express.Router();
const controller = require("../controllers/orderCustomProduct.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

// // API list orders (trả về full dữ liệu)
// router.get("/", authenticateToken, controller.getAllOrders);

// API dành riêng FE (tối ưu chỉ dữ liệu cần hiển thị)
router.get("/fe",
  // authenticateToken, 
  controller.getFrontendOrders);

router.get("/statistic", authenticateToken, controller.getOrderStatistics);

// ⬇️ TÍNH BASE COST
// Tính cho 1 đơn: body { orderId: "..." }
router.post(
  "/compute-base-cost",
  authenticateToken,
  controller.computeBaseCostForOrder
);

// Tính batch cho các đơn thiếu base_cost: body { limit: 50 } (tối đa 200)
router.post(
  "/compute-base-cost/batch",
  authenticateToken,
  controller.computeBaseCostForMany
);

// Manual Mapping
router.put(
  "/manual-mapping",
  // authenticateToken,
  controller.applyManualVendorMapping
);

// API xem chi tiết đơn hàng113-2352267-7335428
router.get("/:id",
  // authenticateToken, 
  controller.getOrderById);

router.post(
  "/update-from-xlsx",
  controller.upload.single("file"),
  controller.updateOrdersFromXlsx
);

router.put("/update-status", authenticateToken, controller.updateOrderStatus);

router.put(
  "/update-shipping-type",
  authenticateToken,
  controller.updateShippingType
);

router.put("/update-base-cost", authenticateToken, controller.updateBaseCost);

router.put(
  "/update-customer-info",
  authenticateToken,
  controller.updateCustomerInfo
);

router.put("/open-case", authenticateToken, controller.openCaseInOrder);

router.put("/remove-case", authenticateToken, controller.removeCaseFromOrder);

router.put(
  "/update-base-image",
  authenticateToken,
  controller.updateBaseImageUrl
);

router.put(
  "/:orderId/items/:orderItemId/tracking",
  authenticateToken,
  controller.updateItemTracking
);

router.put("/:orderId", authenticateToken, controller.updateScaleOrder);

router.post("/:orderId/replace", authenticateToken, controller.createReplacementOrder);

router.post("/:orderId/validate-address", controller.validateAddressByOrderId);

// routes/order.routes.js
router.post("/orders/address/validate-invalid", controller.validateInvalidAddressesBatch);


router.post("/update-tracking", controller.updateTrackingByOrderId);

module.exports = router;
