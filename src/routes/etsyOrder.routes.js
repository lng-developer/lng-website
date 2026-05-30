const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { etsyOrderController } = require("../controllers");
const orderCustomProductController = require("../controllers/orderCustomProduct.controller");
const { authenticateToken, authorizeRoles } = require("../middlewares/auth.middleware");

const uploadDir = path.join(process.cwd(), 'tmp_uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
        cb(null, `${Date.now()}_${safe}`);
    }
});

const upload = multer({ storage });

router.post('/import', upload.array('files', 2), etsyOrderController.importOrders);
router.get('/statistic', etsyOrderController.getEtsyOrderStatistics);
router.get(
    '/scale/list',
    authenticateToken,
    etsyOrderController.getEtsyScaleList
);
router.get(
    '/scale/statistics',
    authenticateToken,
    etsyOrderController.getEtsyScaleStatistics
);
router.get(
    '/qc/list',
    authenticateToken,
    etsyOrderController.getEtsyQCList
);
router.get(
    '/qc/statistics',
    authenticateToken,
    etsyOrderController.getEtsyQCStatistics
);
router.patch('/sumbittedoetsy', etsyOrderController.updateSumbittedoetsyStatus);
router.put('/manual-mapping', authenticateToken, orderCustomProductController.applyManualVendorMapping);
router.post(
    '/:orderId/items/:transactionId/fulfillment-file',
    authenticateToken,
    etsyOrderController.uploadEtsyFulfillmentFileForItem
);
router.post(
    '/:orderId/items/:transactionId/scale/confirm',
    authenticateToken,
    etsyOrderController.confirmEtsyScaleForItem
);
router.put(
    '/:orderId/items/:transactionId/cs-note',
    authenticateToken,
    etsyOrderController.updateEtsyCSNoteForItem
);
router.put(
    '/:orderId/items/:transactionId/qc-note',
    authenticateToken,
    etsyOrderController.updateEtsyQCNoteForItem
);
router.put(
    '/:orderId/assign-cs',
    authenticateToken,
    authorizeRoles("Admin", "Design Leader", "Designer"),
    etsyOrderController.assignEtsyOrderToCS
);
router.put(
    '/:orderId/unassign-cs',
    authenticateToken,
    authorizeRoles("Admin", "Design Leader", "Designer"),
    etsyOrderController.unassignEtsyOrderFromCS
);
router.patch('/:orderId/items/:transactionId/tracking', etsyOrderController.updateEtsyOrderItemTracking);
router.put('/:orderId/items/:transactionId/tracking', etsyOrderController.updateEtsyOrderItemTracking);
router.get('/', etsyOrderController.getListOrders);
router.post('/', etsyOrderController.createOrder);
router.post('/compute-base-cost', etsyOrderController.computeBaseCostForEtsyOrder);

module.exports = router;
