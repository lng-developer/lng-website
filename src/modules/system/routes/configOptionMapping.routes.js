// src/modules/system/routes/configOptionMapping.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/configOptionMapping.controller');
const { authenticateToken, authorizeRoles } = require('../../../middleware/auth.middleware');

router.post('/', authenticateToken, authorizeRoles('Admin'), ctrl.createMappings);
router.put('/upsert', authenticateToken, authorizeRoles('Admin'), ctrl.upsertMapping);
router.get('/', authenticateToken, authorizeRoles('Admin'), ctrl.listMappings);
router.get('/:id', authenticateToken, authorizeRoles('Admin'), ctrl.getMappingById);
router.patch('/:id', authenticateToken, authorizeRoles('Admin'), ctrl.updateMappingById);
router.patch('/:id/active', authenticateToken, authorizeRoles('Admin'), ctrl.toggleActive);
router.delete('/:id', authenticateToken, authorizeRoles('Admin'), ctrl.removeMapping);
router.post('/test', authenticateToken, authorizeRoles('Admin'), ctrl.testMapping);

module.exports = router;

