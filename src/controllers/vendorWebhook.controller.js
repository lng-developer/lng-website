const vendorWebhookService = require("../service/vendorWebhook.service");

const receiveVendorWebhook = async (req, res) => {
  try {
    const provider = req.params.provider;
    const result = await vendorWebhookService.handleWebhook({
      provider,
      payload: req.body || {},
      req,
    });

    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      message: err.message,
      ...(err.event ? { event: err.event } : {}),
    });
  }
};

module.exports = {
  receiveVendorWebhook,
};
