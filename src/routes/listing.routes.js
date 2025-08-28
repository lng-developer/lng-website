const express = require('express');
const router = express.Router();
const listingController = require('../controllers/listing.controller');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const { authenticateToken } = require('../middlewares/auth.middleware');

router.get('/', authenticateToken, listingController.getListings);
router.post('/', authenticateToken, listingController.upsertListing);
router.patch('/:asin/psd', authenticateToken, listingController.updatePSD);
router.delete('/:asin', authenticateToken, listingController.deleteListing);
router.post('/import', authenticateToken, upload.single('file'), listingController.importListingsFromExcel);

module.exports = router;
