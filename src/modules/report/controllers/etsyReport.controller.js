const etsyReportService = require("../services/etsyReport.service");

class EtsyReportController {
  async getEtsyReportMatrix(req, res) {
    try {
      const result = await etsyReportService.getEtsyReportMatrix(req.query, req.user);
      return res.json(result);
    } catch (error) {
      console.error("EtsyReportController.getEtsyReportMatrix error:", error);
      return res.status(500).json({ message: "Failed to get Etsy report", error: error.message });
    }
  }
}

module.exports = new EtsyReportController();

