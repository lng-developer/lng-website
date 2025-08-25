const express = require('express');
const { QCController } = require('../controllers');
const router = express.Router();

router.get(
    '/',
    QCController.getQCList
);

module.exports = router;
