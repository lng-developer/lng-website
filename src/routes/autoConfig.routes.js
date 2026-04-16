const express = require("express");
const router = express.Router();
const { getAll, create, update, remove, runVendorSyncBatch } = require("../controllers/autoConfig.controller");
const { vendorSyncBatch } = require("../controllers/ext.controller");

router.get("/", getAll);
router.post("/", create);
router.put("/:id", update);
router.delete("/:id", remove);
router.post("/run-vendor-sync", runVendorSyncBatch);

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
