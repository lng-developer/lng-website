const express = require('express');
const vendorProductController = require('../controllers/vendorProduct.controller');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

router.get('/', vendorProductController.getAllVendorProducts);
router.post('/', vendorProductController.createVendorProduct);
router.get('/:id', vendorProductController.getVendorProductById);
router.put('/:id', vendorProductController.updateVendorProduct);
router.delete('/:id', vendorProductController.deleteVendorProduct);
router.get('/get-vendor-products-by-vendor-id/:vendorId', vendorProductController.getVendorProductsByVendorId);
router.post('/import-excel', upload.single('file'), vendorProductController.importVendorProductFromExcel);
module.exports = router;

