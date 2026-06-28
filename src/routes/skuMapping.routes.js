// src/routes/skuMapping.routes.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth.middleware');

const cfg = require('../controllers/skuMappingConfig.controller');
const map = require('../controllers/skuMapping.controller');

// Config
router.post('/config', authenticateToken, cfg.createConfig);
router.patch('/config/:id', authenticateToken, cfg.updateConfig);
router.get('/config', cfg.listConfigs);
router.post('/config/:id/active', authenticateToken, cfg.toggleActive);
router.get('/config/active', cfg.getActiveConfigs);

// Mapping
router.post('/preview', map.previewWithConfig);         // body: { orderIds?, configId }
router.post('/apply', authenticateToken, map.applyConfigLogOnly);          // body: { scope, configId, source? }
router.get('/logs', map.listMappings);                  // query filters

module.exports = router;
