const express = require('express');
const { vendorProductController } = require('../controllers');
const router = express.Router();
const multer = require('multer');
const { authenticateToken } = require('../middlewares/auth.middleware');
const upload = multer({ dest: 'uploads/' });

router.get('/', vendorProductController.getAllVendorProducts);
router.post('/', authenticateToken, vendorProductController.createVendorProduct);
router.get('/get-vendor-products-by-vendor-id/:vendorId', vendorProductController.getVendorProductsByVendorId);
router.get('/:id', vendorProductController.getVendorProductById);
router.put('/:id', authenticateToken, vendorProductController.updateVendorProduct);
router.delete('/:id', authenticateToken, vendorProductController.deleteVendorProduct);
router.post('/import-excel', authenticateToken, upload.single('file'), vendorProductController.importVendorProductFromExcel);
module.exports = router;
