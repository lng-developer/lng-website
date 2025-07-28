const express = require('express');
const router = express.Router();
const controller = require('../controllers/orderCustomProduct.controller');

// Upload file JSON
router.post('/import-json-file', controller.upload.single('file'), controller.importOrderFromFile);

// API list orders (trả về full dữ liệu)
router.get('/', controller.getAllOrders);

// API dành riêng FE (tối ưu chỉ dữ liệu cần hiển thị)
router.get('/fe', controller.getFrontendOrders);

// API xem chi tiết đơn hàng
router.get('/:id', controller.getOrderById);

router.post('/update-from-xlsx', controller.upload.single('file'), controller.updateOrdersFromXlsx);

router.put('/update-status', controller.updateOrderStatus);

router.put('/update-shipping-type', controller.updateShippingType);

module.exports = router;
