const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/points.controller');

router.post('/award', authenticateToken, ctrl.award);

router.get('/all/with-logs', authenticateToken, ctrl.getAllWithLogs);
router.get('/:userId/balance', authenticateToken, ctrl.getBalance);
router.get('/:userId/by-day', authenticateToken, ctrl.getByDay);
router.get('/:userId/range', authenticateToken, ctrl.getRange);
router.get('/:userId/logs', authenticateToken, ctrl.getLogs);

module.exports = router;
