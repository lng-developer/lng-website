const express = require("express");
const router = express.Router();
const multer = require("multer");
const etsyListingController = require("../controllers/etsyListing.controller");
// const { authenticateToken } = require("../middlewares/auth.middleware"); // tạm bỏ auth để test

const upload = multer({ dest: "tmp_uploads/" });

router.get("/sync-status", etsyListingController.getEtsyListingSyncStatus);
router.post("/sync", etsyListingController.syncEtsyListings);

router.post(
    "/parse-excel",
    // authenticateToken, // tạm bỏ auth để test
    upload.single("file"),
    etsyListingController.parseEtsyListingFile
);

module.exports = router;
