const express = require('express');
const { vendorCostCenterController } = require('../controllers');

const router = express.Router();

// CRUD APIs
router.get('/', vendorCostCenterController.getAllVendorCostCenters);
router.get('/:id', vendorCostCenterController.getVendorCostCenterById);
router.post('/', vendorCostCenterController.createVendorCostCenter);
router.put('/:id', vendorCostCenterController.updateVendorCostCenter);
router.delete('/:id', vendorCostCenterController.deleteVendorCostCenter);
router.post('/update-status', vendorCostCenterController.updateVendorCostCenterStatus);
router.get('/by-product/:vendorProductId', vendorCostCenterController.getCostCentersByVendorProduct);

module.exports = router;
