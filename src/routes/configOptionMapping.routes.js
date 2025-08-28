// routes/configOptionMapping.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/configOptionMapping.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');
// Tạo 1 hoặc nhiều mapping
router.post('/', authenticateToken, ctrl.createMappings);

// Upsert theo (config_code + key + match_type + match_value)
router.put('/upsert', authenticateToken, ctrl.upsertMapping);

// List + filter + paginate
router.get('/', authenticateToken, ctrl.listMappings);

// Xem chi tiết
router.get('/:id', authenticateToken, ctrl.getMappingById);

// Sửa mapping
router.patch('/:id', authenticateToken, ctrl.updateMappingById);

// Bật/tắt (soft)
router.patch('/:id/active', authenticateToken, ctrl.toggleActive);

// Xoá mềm (active=false)
router.delete('/:id', authenticateToken, ctrl.removeMapping);

// Test thử rule trên 1 value
router.post('/test', authenticateToken, ctrl.testMapping);

module.exports = router;
