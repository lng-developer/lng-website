const express = require('express');
const { QCController } = require('../controllers');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');

router.get('/', authorizeRoles('Customer Service', "Admin"), authenticateToken, QCController.getQCList);

router.get('/statistics', authorizeRoles('Customer Service', "Admin"), authenticateToken, QCController.getQCStatistics);

router.put('/orders/:orderId/items/:orderItemId/qc-note', authorizeRoles('Customer Service', "Admin"), authenticateToken, QCController.updateQCNoteForItem);

module.exports = router;
