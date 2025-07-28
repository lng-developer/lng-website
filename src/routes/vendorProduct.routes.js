const express = require('express');
const { vendorProductController } = require('../controllers');
const router = express.Router();

router.get('/', vendorProductController.getAllVendorProducts);
router.post('/', vendorProductController.createVendorProduct);
router.get('/:id', vendorProductController.getVendorProductById);
router.put('/:id', vendorProductController.updateVendorProduct);
router.delete('/:id', vendorProductController.deleteVendorProduct);

module.exports = router;
