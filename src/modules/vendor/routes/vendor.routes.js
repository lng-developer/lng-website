const express = require('express');
const { authenticateToken, authorizeRoles } = require('../../../middleware/auth.middleware');
const vendorController = require('../controllers/vendor.controller');
const router = express.Router();

router.get('/', vendorController.getAllVendors);
router.post('/', vendorController.createVendor);
router.get('/:id', vendorController.getVendorById);
router.put('/:id', vendorController.updateVendor);
router.delete('/:id', vendorController.deleteVendor);
router.post('/update-status', vendorController.updateVendorStatus);

module.exports = router;

