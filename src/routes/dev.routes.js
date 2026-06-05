const express = require("express");

const { etsyOrderController } = require("../controllers");
const { authenticateToken, authorizeRoles } = require("../middlewares/auth.middleware");

const router = express.Router();

router.post(
    "/etsy/smarty/test-address",
    authenticateToken,
    authorizeRoles("Admin"),
    etsyOrderController.testEtsySmartyAddressValidation
);

module.exports = router;
