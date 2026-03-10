const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ dest: "uploads/" });
const { authenticateToken, authorizeRoles } = require('../../../middleware/auth.middleware');
const listingController = require("../controllers/listing.controller");

router.get("/", authenticateToken, listingController.getListings);
router.post("/", authenticateToken, listingController.upsertListing);
router.patch("/:asin/psd", authenticateToken, listingController.updatePSD);
router.delete("/:id", authenticateToken, listingController.deleteListing);
router.post(
  "/import",
  authenticateToken,
  upload.single("file"),
  listingController.importListingsFromExcel
);
router.get(
  "/:asin/psd-url",
  authenticateToken,
  listingController.getPsdSignedUrl
);
router.get(
  "/statictisc/psd",
  authenticateToken,
  listingController.getPsdStatistics
);

router.get(
  "/statictisc",
  authenticateToken,
  listingController.getListingStatistics
);

router.get(
  "/export-asins",
  listingController.exportAsinSellerStore
);

router.put("/:id", authenticateToken, listingController.updateListing);

module.exports = router;

