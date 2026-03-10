const scaleService = require("../services/scale.service");

class ScaleController {
  async uploadFulfillmentFiles(req, res) {
    try {
      const { orderId, orderItemId } = req.params;
      const { meta } = req.body;
      const positions = JSON.parse(meta);
      const result = await scaleService.uploadFulfillmentFiles(orderId, orderItemId, req.files || [], positions, req.user);
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ message: "Upload failed", error: error.message });
    }
  }

  async confirmScale(req, res) {
    try {
      const { orderId, orderItemId } = req.params;
      const { decision, note, provider } = req.body || {};
      const result = await scaleService.confirmScale(orderId, orderItemId, decision, note, provider, req.user);
      return res.json(result);
    } catch (error) {
      const status = error.message.includes("Invalid address") ? 409 : 500;
      return res.status(status).json({ message: "Confirm failed", error: error.message });
    }
  }
}

module.exports = new ScaleController();

