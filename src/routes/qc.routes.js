const express = require('express');
const { QCController } = require('../controllers');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');

router.get('/', authenticateToken, authorizeRoles('Customer Service', "Admin"), QCController.getQCList);

router.get('/statistics', authenticateToken, authorizeRoles('Customer Service', "Admin"), QCController.getQCStatistics);

router.put('/orders/:orderId/items/:orderItemId/qc-note', authenticateToken, authorizeRoles('Customer Service', "Admin"), QCController.updateQCNoteForItem);

module.exports = router;
