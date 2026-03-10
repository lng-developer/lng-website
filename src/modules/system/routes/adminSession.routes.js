// src/modules/system/routes/adminSession.routes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticateToken, authorizeRoles } = require('../../../middleware/auth.middleware');

router.post('/invalidate-all', authenticateToken, authorizeRoles('Admin'), adminController.invalidateAllSessions);

module.exports = router;

