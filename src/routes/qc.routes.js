const express = require('express');
const { QCController } = require('../controllers');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');

router.get('/', authenticateToken, authorizeRoles('Customer Service', "Admin", "Seller"), QCController.getQCList);

router.get('/statistics', authenticateToken, authorizeRoles('Customer Service', "Admin", "Seller"), QCController.getQCStatistics);

router.post('/send-to-fulfillment', authenticateToken, authorizeRoles('Customer Service', "Admin", "Seller"), QCController.sendFailedOrdersToFulfillment);

router.put('/orders/:orderId/items/:orderItemId/qc-note', authenticateToken, authorizeRoles('Customer Service', "Admin", "Seller"), QCController.updateQCNoteForItem);

module.exports = router;
