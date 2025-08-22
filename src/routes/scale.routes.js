const express = require('express');
const { scaleController } = require('../controllers');
const router = express.Router();

router.post('/orders/:orderId/items/:orderItemId/fulfillment-file', scaleController.uploadFulfillmentFileForItem);

module.exports = router;
