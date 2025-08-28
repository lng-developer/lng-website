// routes/configCostCenter.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/configCostCenter.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

router.get('/', authenticateToken, ctrl.listConfigs);
router.get('/:id', authenticateToken, ctrl.getConfig);
router.post('/', authenticateToken, ctrl.createConfig);
router.patch('/:id', authenticateToken, ctrl.updateConfig);
router.patch('/:id/status', authenticateToken, ctrl.toggleStatus);
router.patch('/:id/flags', authenticateToken, ctrl.toggleFlags);
router.delete('/:id', authenticateToken, ctrl.removeConfig);

module.exports = router;
