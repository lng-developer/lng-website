const express = require('express');
const { vendorController } = require('../controllers');
const router = express.Router();

router.get('/', vendorController.getAllVendors);
router.post('/', vendorController.createVendor);
router.get('/:id', vendorController.getVendorById);
router.put('/:id', vendorController.updateVendor);
router.delete('/:id', vendorController.deleteVendor);
router.post('/update-status', vendorController.updateVendorStatus);

module.exports = router;
