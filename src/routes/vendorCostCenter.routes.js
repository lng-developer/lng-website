const express = require('express');
const { vendorCostCenterController } = require('../controllers');
const multer = require('multer'); // 🟢 THÊM DÒNG NÀY
const upload = multer({ dest: 'uploads/' }); // 🟢 VÀ DÒNG NÀY
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

module.exports = router;
