const express = require("express");
const router = express.Router();
const { getAll, create, update, remove, runVendorSyncBatch } = require("../controllers/autoConfig.controller");
const { vendorSyncBatch } = require("../controllers/ext.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.get("/", getAll);
router.post("/", authenticateToken, create);
router.put("/:id", authenticateToken, update);
router.delete("/:id", authenticateToken, remove);
router.post("/run-vendor-sync", authenticateToken, runVendorSyncBatch);

// Auto gọi vendorSyncBatch mỗi 2 tiếng
setInterval(async () => {
  try {
    const mockReq = { body: { max: 100, dryRun: false }, headers: {} };
    const mockRes = {
      json: () => {},
      status: () => ({ json: () => {} })
    };
    await vendorSyncBatch(mockReq, mockRes);
  } catch (err) {
    console.error(`❌ [AUTO] vendorSyncBatch failed: ${err.message}`);
  }
}, 2 * 60 * 60 * 1000);

module.exports = router;
