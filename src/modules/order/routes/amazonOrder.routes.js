const express = require("express");
const router = express.Router();
const controller = require("../controllers/orderCustomProduct.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");

// Legacy Amazon Custom Product Routes
router.use(authenticateToken);

router.get("/fe", controller.getFrontendOrders);
router.get("/statistic", controller.getOrderStatistics);

router.post("/compute-base-cost", controller.computeBaseCostForOrder);
router.post("/compute-base-cost/batch", controller.computeBaseCostForMany);

router.get("/:id", controller.getOrderById);
router.post("/update-from-xlsx", controller.upload.single("file"), controller.updateOrdersFromXlsx);
router.put("/update-status", controller.updateOrderStatus);
router.put("/update-shipping-type", controller.updateShippingType);
router.put("/update-base-cost", controller.updateBaseCost);
router.put("/update-customer-info", controller.updateCustomerInfo);
router.put("/open-case", controller.openCaseInOrder);
router.put("/remove-case", controller.removeCaseFromOrder);
router.put("/update-base-image", controller.updateBaseImageUrl);
router.put("/:orderId/items/:orderItemId/tracking", controller.updateItemTracking);
router.put("/:orderId", controller.updateScaleOrder);
router.post("/:orderId/replace", controller.createReplacementOrder);
router.post("/:orderId/validate-address", controller.validateAddressByOrderId);
router.post("/orders/address/validate-invalid", controller.validateInvalidAddressesBatch);
router.post("/update-tracking", controller.updateTrackingByOrderId);

module.exports = router;

