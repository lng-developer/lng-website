const express = require('express');
const { QCController } = require('../controllers');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth.middleware');

router.get('/', authenticateToken, QCController.getQCList);

router.get('/statistics', authenticateToken, QCController.getQCStatistics);

router.put('/orders/:orderId/items/:orderItemId/qc-note', authenticateToken, QCController.updateQCNoteForItem);

module.exports = router;
