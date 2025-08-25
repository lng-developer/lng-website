const express = require('express');
const { scaleController } = require('../controllers');
const router = express.Router();

router.post(
    '/orders/:orderId/items/:orderItemId/fulfillment-file',
    scaleController.uploadFulfillmentFileForItem
);

// Xác nhận per item (approve/reject) + auto-send khi đủ
router.post(
    '/orders/:orderId/items/:orderItemId/scale/confirm',
    scaleController.confirmScaleForItem
);

// (Tuỳ chọn) Retry gửi toàn bộ order khi Ready/Failed
router.post(
    '/orders/:orderId/scale/send',
    scaleController.retrySendGrabink
);

router.put('/orders/:orderId/items/:orderItemId/cs-note', scaleController.updateCSNoteForItem);

module.exports = router;
