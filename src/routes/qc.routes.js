const express = require('express');
const { QCController } = require('../controllers');
const router = express.Router();

router.get(
    '/',
    QCController.getQCList
);

router.get('/statistics', QCController.getQCStatistics);

module.exports = router;
