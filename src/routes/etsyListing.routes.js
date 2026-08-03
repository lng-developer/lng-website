const express = require("express");
const router = express.Router();
const multer = require("multer");
const etsyListingController = require("../controllers/etsyListing.controller");
// const { authenticateToken } = require("../middlewares/auth.middleware"); // tạm bỏ auth để test

const upload = multer({ dest: "tmp_uploads/" });

router.get("/sync-status", etsyListingController.getEtsyListingSyncStatus);
router.post("/design-file", etsyListingController.uploadEtsyListingDesignFile);
router.delete("/design-file", etsyListingController.deleteEtsyListingDesignFile);
router.get("/design-file/download", etsyListingController.getEtsyListingDesignFileSignedUrl);
router.get("/", etsyListingController.listEtsyListings);
router.get("/:id", etsyListingController.getEtsyListingDetail);
router.post("/sync", etsyListingController.syncEtsyListings);

router.post(
    "/parse-excel",
    // authenticateToken, // tạm bỏ auth để test
    upload.single("file"),
    etsyListingController.parseEtsyListingFile
);

module.exports = router;
