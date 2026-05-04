const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { etsyOrderController } = require("../controllers");

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
router.get('/', etsyOrderController.getListOrders);
router.post('/', etsyOrderController.createOrder);
router.post('/compute-base-cost', etsyOrderController.computeBaseCostForEtsyOrder);

module.exports = router;
