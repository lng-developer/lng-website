const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/points.controller');

// Cộng điểm từ task (Admin)
router.post('/award', authenticateToken, ctrl.award);

// Tổng điểm hiện tại
router.get('/:userId/balance', authenticateToken, ctrl.getBalance);

// Điểm trong 1 ngày
router.get('/:userId/by-day', authenticateToken, ctrl.getByDay);

// Điểm theo khoảng ngày
router.get('/:userId/range', authenticateToken, ctrl.getRange);

// Lịch sử log gần đây
router.get('/:userId/logs', authenticateToken, ctrl.getLogs);

module.exports = router;
