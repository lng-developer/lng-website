const qcService = require("../services/qc.service");

class QCController {
  async getQCList(req, res) {
    try {
      const result = await qcService.getQCList(req.query);
      return res.json(result);
    } catch (error) {
      console.error("QCController.getQCList error:", error);
      return res.status(500).json({ message: "Failed to retrieve QC list", error: error.message });
    }
  }

  async getQCStatistics(req, res) {
    try {
      const result = await qcService.getQCStatistics(req.query);
      return res.json(result);
    } catch (error) {
      console.error("QCController.getQCStatistics error:", error);
      return res.status(500).json({ message: "Failed to retrieve QC statistics", error: error.message });
    }
  }

  async updateQCNoteForItem(req, res) {
    try {
      const { orderId, orderItemId } = req.params;
      const { qc_note } = req.body || {};
      const item = await qcService.updateQCNoteForItem(orderId, orderItemId, qc_note);
      return res.json({ message: "QC note updated.", orderId, orderItemId, qc_note: item.qc_note });
    } catch (error) {
      return res.status(500).json({ message: "Update QC note failed", error: error.message });
    }
  }
}

module.exports = new QCController();

