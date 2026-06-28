const express = require('express');
const { vendorCostCenterController } = require('../controllers');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const { authenticateToken } = require('../middlewares/auth.middleware');
const router = express.Router();

// CRUD APIs
router.get('/', vendorCostCenterController.getAllVendorCostCenters);
router.get('/manual-search', vendorCostCenterController.manualSearchVendorCosts);
router.get('/list-product', vendorCostCenterController.getListVendorProduct);
router.get('/by-product/:vendorProductId', vendorCostCenterController.getCostCentersByVendorProduct);
router.get('/variants/:vendorProductId/lookup', vendorCostCenterController.lookupSpecificVariant);
router.get('/variants/:vendorProductId', vendorCostCenterController.getVendorProductVariants);
router.get('/:id', vendorCostCenterController.getVendorCostCenterById);
router.post('/', authenticateToken, vendorCostCenterController.createVendorCostCenter);
router.put('/:id', authenticateToken, vendorCostCenterController.updateVendorCostCenter);
router.delete('/:id', authenticateToken, vendorCostCenterController.deleteVendorCostCenter);
router.post('/update-status', authenticateToken, vendorCostCenterController.updateVendorCostCenterStatus);
router.post('/import', authenticateToken, upload.single('file'), vendorCostCenterController.importVendorCostCenterFromExcel);
router.post('/bulk-update', authenticateToken, upload.single('file'), vendorCostCenterController.bulkUpdateVendorCostCenterFromExcel);

module.exports = router;
