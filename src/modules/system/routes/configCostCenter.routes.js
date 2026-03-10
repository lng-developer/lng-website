// src/modules/system/routes/configCostCenter.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/configCostCenter.controller');
const { authenticateToken, authorizeRoles } = require('../../../middleware/auth.middleware');

router.get('/', authenticateToken, authorizeRoles('Admin'), ctrl.listConfigs);
router.get('/:id', authenticateToken, authorizeRoles('Admin'), ctrl.getConfig);
router.post('/', authenticateToken, authorizeRoles('Admin'), ctrl.createConfig);
router.patch('/:id', authenticateToken, authorizeRoles('Admin'), ctrl.updateConfig);
router.patch('/:id/status', authenticateToken, authorizeRoles('Admin'), ctrl.toggleStatus);
router.patch('/:id/flags', authenticateToken, authorizeRoles('Admin'), ctrl.toggleFlags);
router.delete('/:id', authenticateToken, authorizeRoles('Admin'), ctrl.removeConfig);

module.exports = router;

