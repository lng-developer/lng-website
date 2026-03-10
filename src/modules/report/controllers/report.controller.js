const reportService = require("../services/report.service");

class ReportController {
    async importReportFromFile(req, res, next) {
        try {
            if (!req.file?.buffer) {
                return res.status(400).json({ message: "Send form-data 'file' (txt)" });
            }
            const isDryRun = req.query.dryRun === "true";
            const result = await reportService.importReportFromFile({ fileBuffer: req.file.buffer, dryRun: isDryRun });
            return res.json(result);
        } catch (err) {
            if (err.message && err.message.includes("Send form-data")) return res.status(400).json({ message: err.message });
            next(err);
        }
    }

    async getReportMatrix(req, res, next) {
        try {
            const result = await reportService.getReportMatrix(req.query, req.user);
            return res.json(result);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ message: err.message });
            if (err.message && (err.message.includes("are required") || err.message.includes("Invalid"))) return res.status(400).json({ message: err.message });
            next(err);
        }
    }

    async getOrderCostStatistics(req, res, next) {
        try {
            const result = await reportService.getOrderCostStatistics(req.query, req.user);
            return res.json(result);
        } catch (err) {
            if (err.message && err.message.includes("Invalid user id")) return res.status(400).json({ message: err.message });
            next(err);
        }
    }

    async importAmazonRefundCSV(req, res, next) {
        try {
            if (!req.file?.buffer) return res.status(400).json({ message: "CSV file is required" });
            const result = await reportService.importAmazonRefundCSV(req.file.buffer);
            return res.json(result);
        } catch (err) {
            if (err.message && err.message.includes("is required")) return res.status(400).json({ message: err.message });
            next(err);
        }
    }

    async exportOrdersCostExcel(req, res, next) {
        try {
            const { fileName, buffer } = await reportService.exportOrdersCostExcel(req.query);
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
            return res.send(buffer);
        } catch (err) {
            if (err.message && (err.message.includes("required") || err.message.includes("valid ISO"))) return res.status(400).json({ message: err.message });
            next(err);
        }
    }

    async exportAmazonAdsSpendBySellerExcel(req, res, next) {
        try {
            const { fileName, buffer } = await reportService.exportAmazonAdsSpendBySellerExcel(req.query);
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
            return res.send(buffer);
        } catch (err) {
            if (err.message && (err.message.includes("required") || err.message.includes("valid ISO"))) return res.status(400).json({ message: err.message });
            next(err);
        }
    }
}

module.exports = new ReportController();

