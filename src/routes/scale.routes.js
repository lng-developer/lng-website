const express = require('express');
const { scaleController } = require('../controllers');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');

router.post(
    '/orders/:orderId/items/:orderItemId/fulfillment-file',
    authenticateToken, authorizeRoles('Customer Service' || "Admin" || "Seller"),
    scaleController.uploadFulfillmentFileForItem
);

// Xác nhận per item (approve/reject) + auto-send khi đủ
router.post(
    '/orders/:orderId/items/:orderItemId/scale/confirm',
    authenticateToken, authorizeRoles('Customer Service' || "Admin" || "Seller"),
    scaleController.confirmScaleForItem
);

// (Tuỳ chọn) Retry gửi toàn bộ order khi Ready/Failed
router.post(
    '/orders/:orderId/scale/send',
    authenticateToken, authorizeRoles('Customer Service' || "Admin" || "Seller"),
    scaleController.retrySendGrabink
);

router.put('/orders/:orderId/items/:orderItemId/cs-note', authenticateToken, authorizeRoles('Customer Service' || "Admin" || "Seller"), scaleController.updateCSNoteForItem);

router.get('/list', authenticateToken, authorizeRoles('Customer Service' || "Admin" || "Seller"), scaleController.getScaleList);

router.get('/statistics', authenticateToken, authorizeRoles('Customer Service' || "Admin" || "Seller"), scaleController.getScaleStatistics);

module.exports = router;
