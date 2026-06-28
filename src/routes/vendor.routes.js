const express = require('express');
const { vendorController } = require('../controllers');
const { authenticateToken } = require('../middlewares/auth.middleware');
const router = express.Router();

router.get('/', vendorController.getAllVendors);
router.post('/', authenticateToken, vendorController.createVendor);
router.get('/:id', vendorController.getVendorById);
router.put('/:id', authenticateToken, vendorController.updateVendor);
router.delete('/:id', authenticateToken, vendorController.deleteVendor);
router.post('/update-status', authenticateToken, vendorController.updateVendorStatus);

module.exports = router;
