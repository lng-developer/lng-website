// src/modules/catalog/controllers/listing.controller.js
const listingService = require('../services/listing.service');
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const getListings = async (req, res, next) => {
    try {
        const result = await listingService.getListings(req.query, req.user);
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: "Error fetching listings", error: error.message });
    }
};

const getPsdStatistics = async (req, res, next) => {
    try {
        const result = await listingService.getPsdStatistics(req.query);
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: "Error fetching PSD statistics", error: error.message });
    }
};

const getListingStatistics = async (req, res, next) => {
    try {
        const result = await listingService.getListingStatistics(req.query, req.user);
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: "Error fetching PSD statistics", error: error.message });
    }
};

const upsertListing = async (req, res, next) => {
    try {
        const updated = await listingService.upsertListing(req.body);
        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: "Error upserting listing", error: error.message });
    }
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
    fileFilter: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || "").toLowerCase();
        if (ext !== ".zip") return cb(new Error("Chỉ chấp nhận .zip"));
        cb(null, true);
    },
});

const updatePSD = [
    upload.single("file"),
    async (req, res, next) => {
        try {
            const result = await listingService.updateListingPSD(req.params.asin, req.body.status, req.file);
            res.json(result);
        } catch (err) {
            if (err.message && (err.message.includes('Thiếu') || err.message.includes('chấp nhận'))) {
                return res.status(400).json({ message: err.message });
            }
            res.status(500).json({ message: "Error updating design file", error: err.message });
        }
    },
];

const getPsdSignedUrl = async (req, res, next) => {
    try {
        const result = await listingService.getPsdSignedUrl(req.params.asin, req.query);
        res.json(result);
    } catch (error) {
        if (error.status === 404) {
            return res.status(404).json({ message: error.message });
        }
        res.status(500).json({ message: "Lỗi tạo signed URL", error: error.message });
    }
};

const deleteListing = async (req, res, next) => {
    try {
        await listingService.deleteListing(req.params.id);
        res.json({ message: "Listing deleted" });
    } catch (error) {
        res.status(500).json({ message: "Error deleting listing", error: error.message });
    }
};

const updateListing = async (req, res, next) => {
    try {
        await listingService.updateListing(req.params.id, req.body);
        res.json({ message: "Listing updated" });
    } catch (error) {
        res.status(500).json({ message: "Error update listing", error: error.message });
    }
};

const importListingsFromExcel = async (req, res, next) => {
    try {
        const filePath = req.file.path;
        const workbook = XLSX.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        const result = await listingService.importListingsFromExcelData(rows);
        fs.unlinkSync(filePath);

        res.json(result);
    } catch (error) {
        if (req.file?.path) {
            try { fs.unlinkSync(req.file.path); } catch (e) { }
        }
        if (error.status === 400) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: "Lỗi import", error: error.message });
    }
};

const exportAsinSellerStore = async (req, res, next) => {
    try {
        const { rows } = await listingService.getAsinSellerStoreExportData(req.query, req.user);

        if (!rows || !rows.length) {
            return res.json({
                message: "Không có dữ liệu để export",
                total: 0,
            });
        }

        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "ASINs");

        const buffer = XLSX.write(workbook, {
            bookType: "xlsx",
            type: "buffer",
        });

        const filename = `asin_seller_store_${Date.now()}.xlsx`;

        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        return res.status(200).send(Buffer.from(buffer));
    } catch (error) {
        res.status(500).json({ message: "Lỗi export ASIN", error: error.message });
    }
};

module.exports = {
    getListings,
    upsertListing,
    updatePSD,
    deleteListing,
    importListingsFromExcel,
    getPsdSignedUrl,
    getPsdStatistics,
    getListingStatistics,
    updateListing,
    exportAsinSellerStore
};

