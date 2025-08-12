// routes/configCostCenter.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/configCostCenter.controller');

// Middleware auth/role (nếu có) kẹp vào đây

router.get('/', ctrl.listConfigs);                 // ?page=&perPage=&platform=&status=&search=&product_for_seller=&product_for_seller_name=
router.get('/:id', ctrl.getConfig);

router.post('/', ctrl.createConfig);
router.patch('/:id', ctrl.updateConfig);
router.patch('/:id/status', ctrl.toggleStatus);    // { status: 'Active' | 'Inactive' }
router.patch('/:id/flags', ctrl.toggleFlags);      // { is_set?: bool, is_pack?: bool }
router.delete('/:id', ctrl.removeConfig);

module.exports = router;
