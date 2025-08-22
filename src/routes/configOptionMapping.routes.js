// routes/configOptionMapping.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/configOptionMapping.controller');

// Tạo 1 hoặc nhiều mapping
router.post('/', ctrl.createMappings);

// Upsert theo (config_code + key + match_type + match_value)
router.put('/upsert', ctrl.upsertMapping);

// List + filter + paginate
router.get('/', ctrl.listMappings);

// Xem chi tiết
router.get('/:id', ctrl.getMappingById);

// Sửa mapping
router.patch('/:id', ctrl.updateMappingById);

// Bật/tắt (soft)
router.patch('/:id/active', ctrl.toggleActive);

// Xoá mềm (active=false)
router.delete('/:id', ctrl.removeMapping);

// Test thử rule trên 1 value
router.post('/test', ctrl.testMapping);

module.exports = router;
