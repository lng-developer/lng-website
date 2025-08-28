const express = require('express');
const { roleController } = require('../controllers');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');

router.get('/', authenticateToken, authorizeRoles('Admin'), roleController.getAllRoles);
router.get('/:id', authenticateToken, authorizeRoles('Admin'), roleController.getRoleById);
router.post('/', authenticateToken, authorizeRoles('Admin'), roleController.createRole);
router.put('/:id', authenticateToken, authorizeRoles('Admin'), roleController.updateRole);
router.delete('/:id', authenticateToken, authorizeRoles('Admin'), roleController.deleteRole);

module.exports = router;
