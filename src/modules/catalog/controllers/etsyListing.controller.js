// src/modules/catalog/controllers/etsyListing.controller.js
const etsyListingService = require('../services/etsyListing.service');
const fs = require("fs");

/**
 * API parse file Excel/CSV chứa Etsy listing
 * Nhận file upload, đọc và trả về JSON với các trường: TITLE, IMAGE1-IMAGE10, SKU
 */
const parseEtsyListingFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Vui lòng upload file Excel hoặc CSV.",
            });
        }

        const result = await etsyListingService.parseEtsyListingFileData(req.file.path);

        // Xóa file tạm
        fs.unlinkSync(req.file.path);

        return res.status(200).json({
            success: true,
            total: result.total,
            inserted: result.inserted,
            updated: result.updated,
            data: result.data,
        });

    } catch (error) {
        // Xóa file tạm nếu có lỗi
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (_) { }
        }

        console.error("parseEtsyListingFile error:", error);

        if (error.status === 400) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }

        return res.status(500).json({
            success: false,
            message: "Lỗi khi xử lý file: " + error.message,
        });
    }
};

module.exports = {
    parseEtsyListingFile,
};

