const vendorWebhookService = require("../service/vendorWebhook.service");
const vendorWebhookLogService = require("../service/vendorWebhookLog.service");

const verifyVendorWebhookEndpoint = (req, res) => {
  return res.status(200).json({
    ok: true,
    provider: req.params.provider || "",
    message: "Vendor webhook endpoint is available",
  });
};

const receiveVendorWebhook = async (req, res) => {
  const provider = req.params.provider;
  const payload = req.body || {};

  try {
    const result = await vendorWebhookService.handleWebhook({
      provider,
      payload,
      req,
    });

    await vendorWebhookLogService.safeCreateVendorWebhookLog({
      provider,
      req,
      payload,
      result,
      httpStatus: 200,
    });

    return res.json(result);
  } catch (err) {
    const httpStatus = err.status || 500;
    await vendorWebhookLogService.safeCreateVendorWebhookLog({
      provider,
      req,
      payload,
      error: err,
      httpStatus,
    });

    return res.status(httpStatus).json({
      ok: false,
      message: err.message,
      ...(err.event ? { event: err.event } : {}),
    });
  }
};

const listVendorWebhookLogs = async (req, res) => {
  try {
    const result = await vendorWebhookLogService.listVendorWebhookLogs(req.query || {});
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      message: "Failed to list vendor webhook logs",
      error: err.message,
    });
  }
};

module.exports = {
  verifyVendorWebhookEndpoint,
  receiveVendorWebhook,
  listVendorWebhookLogs,
};
