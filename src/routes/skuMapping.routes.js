// src/routes/skuMapping.routes.js
const express = require('express');
const router = express.Router();

const cfg = require('../controllers/skuMappingConfig.controller');
const map = require('../controllers/skuMapping.controller');

// Config
router.post('/config', cfg.createConfig);
router.patch('/config/:id', cfg.updateConfig);
router.get('/config', cfg.listConfigs);
router.post('/config/:id/active', cfg.toggleActive);
router.get('/config/active', cfg.getActiveConfigs);

// Mapping
router.post('/preview', map.previewWithConfig);         // body: { orderIds?, configId }
router.post('/apply', map.applyConfigLogOnly);          // body: { scope, configId, source? }
router.get('/logs', map.listMappings);                  // query filters

module.exports = router;
