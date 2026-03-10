const express = require('express');
const multer = require('multer');
const { authenticateToken, authorizeRoles } = require('../../../middleware/auth.middleware');
const vendorCostCenterController = require('../controllers/vendorCostCenter.controller');
const upload = multer({ dest: 'uploads/' });
const router = express.Router();

// CRUD APIs
router.get('/', vendorCostCenterController.getAllVendorCostCenters);
router.get('/:id', vendorCostCenterController.getVendorCostCenterById);
router.post('/', vendorCostCenterController.createVendorCostCenter);
router.put('/:id', vendorCostCenterController.updateVendorCostCenter);
router.delete('/:id', vendorCostCenterController.deleteVendorCostCenter);
router.post('/update-status', vendorCostCenterController.updateVendorCostCenterStatus);
router.get('/by-product/:vendorProductId', vendorCostCenterController.getCostCentersByVendorProduct);
router.post('/import', upload.single('file'), vendorCostCenterController.importVendorCostCenterFromExcel);
router.post('/bulk-update', upload.single('file'), vendorCostCenterController.bulkUpdateVendorCostCenterFromExcel);

module.exports = router;

