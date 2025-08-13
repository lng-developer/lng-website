const express = require('express');
const router = express.Router();
const controller = require('../controllers/orderCustomProduct.controller');

// Upload file JSON
router.post('/import-json-file', controller.upload.single('file'), controller.importOrderFromFile);

// API list orders (trả về full dữ liệu)
router.get('/', controller.getAllOrders);

// API dành riêng FE (tối ưu chỉ dữ liệu cần hiển thị)
router.get('/fe', controller.getFrontendOrders);

router.get('/statistic', controller.getOrderStatistics);

// ⬇️ TÍNH BASE COST
// Tính cho 1 đơn: body { orderId: "..." }
router.post('/compute-base-cost', controller.computeBaseCostForOrder);

// Tính batch cho các đơn thiếu base_cost: body { limit: 50 } (tối đa 200)
router.post('/compute-base-cost/batch', controller.computeBaseCostForMany);

// API xem chi tiết đơn hàng
router.get('/:id', controller.getOrderById);

router.post('/update-from-xlsx', controller.upload.single('file'), controller.updateOrdersFromXlsx);

router.put('/update-status', controller.updateOrderStatus);

router.put('/update-shipping-type', controller.updateShippingType);

router.put('/update-base-cost', controller.updateBaseCost);

router.put('/update-customer-info', controller.updateCustomerInfo);

router.put('/open-case', controller.openCaseInOrder);

router.put('/remove-case', controller.removeCaseFromOrder);

router.put('/update-base-image', controller.updateBaseImageUrl);

module.exports = router;
