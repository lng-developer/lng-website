const express = require('express');
const router = express.Router();
const listingController = require('../controllers/listing.controller');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

router.get('/', listingController.getListings);
router.post('/', listingController.upsertListing);
router.patch('/:asin/psd', listingController.updatePSD);
router.delete('/:asin', listingController.deleteListing);
router.post('/import', upload.single('file'), listingController.importListingsFromExcel);

module.exports = router;
