const express = require('express');
const { QCController } = require('../controllers');
const router = express.Router();

router.get(
    '/',
    QCController.getQCList
);

router.get('/statistics', QCController.getQCStatistics);

router.put('/orders/:orderId/items/:orderItemId/qc-note', QCController.updateQCNoteForItem);

module.exports = router;
