// src/modules/system/routes/auditLog.routes.js
const express = require('express');
const router = express.Router();
const auditLogController = require('../controllers/auditLog.controller');
const { authenticateToken, authorizeRoles } = require('../../../middleware/auth.middleware');

router.get('/order-history', authenticateToken, authorizeRoles('Admin', 'Leader'), auditLogController.listOrderHistory);
router.get('/order-history/:id', authenticateToken, authorizeRoles('Admin', 'Leader'), auditLogController.getOrderHistoryById);

module.exports = router;

