const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { etsyOrderController } = require("../controllers");
const orderCustomProductController = require("../controllers/orderCustomProduct.controller");
const { authenticateToken, authorizeRoles } = require("../middlewares/auth.middleware");
const {
    downloadPendingEtsyCustomFiles,
    markEtsyCustomFilesAsExternalLinks,
} = require("../service/etsyCustomFile.service");

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

router.post('/import', authenticateToken, upload.array('files', 2), etsyOrderController.importOrders);
router.get('/statistic', etsyOrderController.getEtsyOrderStatistics);
router.get(
    '/scale/list',
    authenticateToken,
    authorizeRoles(
        "Customer Service",
        "Admin",
        "Seller",
        "Design Leader",
        "Designer"
    ),
    etsyOrderController.getEtsyScaleList
);
router.get(
    '/scale/statistics',
    authenticateToken,
    authorizeRoles(
        "Customer Service",
        "Admin",
        "Seller",
        "Design Leader",
        "Designer"
    ),
    etsyOrderController.getEtsyScaleStatistics
);
router.get(
    '/qc/list',
    authenticateToken,
    authorizeRoles('Customer Service', "Admin", "Seller", "Design Leader"),
    etsyOrderController.getEtsyQCList
);
router.get(
    '/qc/statistics',
    authenticateToken,
    authorizeRoles('Customer Service', "Admin", "Seller", "Design Leader"),
    etsyOrderController.getEtsyQCStatistics
);
router.post(
    '/qc/push-platform-orders',
    authenticateToken,
    authorizeRoles('Customer Service', "Admin", "Seller"),
    etsyOrderController.pushEtsyPlatformOrders
);
router.patch('/sumbittedoetsy', authenticateToken, etsyOrderController.updateSumbittedoetsyStatus);
router.put('/manual-mapping', authenticateToken, orderCustomProductController.applyManualVendorMapping);
router.put('/reset-base-cost', authenticateToken, etsyOrderController.resetBaseCostForEtsyOrder);
router.post('/compute-base-cost/batch', authenticateToken, etsyOrderController.computeMissingBaseCostsForEtsyOrders);
router.put('/scale/orders/reset/bulk', authenticateToken, etsyOrderController.resetEtsyScaleForOrdersBulk);
router.put('/open-case', authenticateToken, etsyOrderController.openCaseInEtsyOrder);
router.put('/remove-case', authenticateToken, etsyOrderController.removeCaseFromEtsyOrder);
router.post(
    '/custom-files/download-pending',
    authenticateToken,
    authorizeRoles("Admin", "Design Leader"),
    async (req, res) => {
        try {
            const result = await downloadPendingEtsyCustomFiles(req.body || {});
            return res.json({ ok: true, ...result });
        } catch (err) {
            return res.status(500).json({ ok: false, message: err.message });
        }
    }
);
router.post(
    '/custom-files/mark-external-links',
    authenticateToken,
    authorizeRoles("Admin", "Design Leader"),
    async (req, res) => {
        try {
            const result = await markEtsyCustomFilesAsExternalLinks(req.body || {});
            return res.json({ ok: true, ...result });
        } catch (err) {
            return res.status(500).json({ ok: false, message: err.message });
        }
    }
);
router.post(
    '/:orderId/items/:transactionId/fulfillment-file',
    authenticateToken,
    etsyOrderController.uploadEtsyFulfillmentFileForItem
);
router.post(
    '/:orderId/items/:transactionId/scale/confirm',
    authenticateToken,
    authorizeRoles("Customer Service", "Admin", "Seller"),
    etsyOrderController.confirmEtsyScaleForItem
);
router.post(
    '/:orderId/scale/send',
    authenticateToken,
    authorizeRoles("Customer Service", "Admin", "Seller"),
    etsyOrderController.retrySendEtsyFulfillment
);
router.patch(
    '/:orderId/scale/reopen-qc',
    authenticateToken,
    authorizeRoles("Customer Service", "Admin", "Seller", "Design Leader"),
    etsyOrderController.reopenEtsyQc
);
router.post(
    '/:orderId/replace',
    authenticateToken,
    authorizeRoles("Customer Service", "Admin", "Seller"),
    etsyOrderController.createEtsyReplacementOrder
);
router.put(
    '/:orderId/items/:transactionId/cs-note',
    authenticateToken,
    authorizeRoles("Customer Service", "Admin", "Seller"),
    etsyOrderController.updateEtsyCSNoteForItem
);
router.put(
    '/:orderId/items/:transactionId/qc-note',
    authenticateToken,
    authorizeRoles('Customer Service', "Admin", "Seller"),
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
router.put(
    '/:orderId/address',
    authenticateToken,
    authorizeRoles("Customer Service", "Admin", "Seller"),
    etsyOrderController.updateEtsyOrderAddress
);
router.patch(
    '/:orderId/address',
    authenticateToken,
    authorizeRoles("Customer Service", "Admin", "Seller"),
    etsyOrderController.updateEtsyOrderAddress
);
router.patch(
    '/:orderId/items/:transactionId/quantity',
    authenticateToken,
    etsyOrderController.updateEtsyOrderItemQuantity
);
router.patch('/:orderId/tracking', authenticateToken, etsyOrderController.updateEtsyOrderTrackingForAllItems);
router.put('/:orderId/tracking', authenticateToken, etsyOrderController.updateEtsyOrderTrackingForAllItems);
router.patch('/:orderId/items/:transactionId/tracking', authenticateToken, etsyOrderController.updateEtsyOrderItemTracking);
router.put('/:orderId/items/:transactionId/tracking', authenticateToken, etsyOrderController.updateEtsyOrderItemTracking);
router.get('/', etsyOrderController.getListOrders);
router.post('/', etsyOrderController.createOrder);
router.post('/compute-base-cost', authenticateToken, etsyOrderController.computeBaseCostForEtsyOrder);

module.exports = router;
