const adsService = require("../services/ads.service");

class AdsController {
    async importAdsForDay(req, res, next) {
        try {
            if (!req.file?.buffer) return res.status(400).json({ message: "Send form-data 'file'." });
            const { day, shopId } = req.body;
            if (!day) return res.status(400).json({ message: "form-data 'day' is required." });
            if (!shopId) return res.status(400).json({ message: "form-data 'shopId' is required." });
            const result = await adsService.importAdsForDay({ day, shopId, fileBuffer: req.file.buffer });
            return res.json(result);
        } catch (err) {
            if (err.message.includes("Invalid day format") || err.message.includes("is required")) return res.status(400).json({ message: err.message });
            next(err);
        }
    }

    async getAdsSummary(req, res, next) {
        try {
            const { from, to, seller } = req.query;
            if (!from || !to) return res.status(400).json({ message: "Query 'from' & 'to' are required (ISO UTC)" });
            const result = await adsService.getAdsSummary({ from, to, seller });
            return res.json(result);
        } catch (err) {
            next(err);
        }
    }
}

module.exports = new AdsController();

