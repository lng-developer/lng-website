const XLSX = require("xlsx");
const fs = require("fs");
const EtsyListing = require("../models/etsyListing.model");

// Các cột cần extract từ file Excel/CSV
const REQUIRED_COLUMNS = [
    "TITLE",
    "IMAGE1",
    "IMAGE2",
    "IMAGE3",
    "IMAGE4",
    "IMAGE5",
    "IMAGE6",
    "IMAGE7",
    "IMAGE8",
    "IMAGE9",
    "IMAGE10",
    "SKU",
];

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

        const filePath = req.file.path;

        // Đọc file bằng xlsx (hỗ trợ cả .xlsx, .xls, .csv)
        const workbook = XLSX.readFile(filePath, { type: "file" });

        // Lấy sheet đầu tiên
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
            // Xóa file tạm
            fs.unlinkSync(filePath);
            return res.status(400).json({
                success: false,
                message: "File không có sheet nào.",
            });
        }

        const sheet = workbook.Sheets[sheetName];

        // Convert sheet sang JSON (header row = key)
        const rawData = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        if (!rawData || rawData.length === 0) {
            fs.unlinkSync(filePath);
            return res.status(400).json({
                success: false,
                message: "File không có dữ liệu.",
            });
        }

        // Validate: kiểm tra header có chứa ít nhất TITLE và SKU
        const firstRowKeys = Object.keys(rawData[0]);
        const missingColumns = ["TITLE", "SKU"].filter(
            (col) => !firstRowKeys.includes(col)
        );

        if (missingColumns.length > 0) {
            fs.unlinkSync(filePath);
            return res.status(400).json({
                success: false,
                message: `File thiếu các cột bắt buộc: ${missingColumns.join(", ")}`,
            });
        }

        // Extract chỉ các trường cần thiết
        const data = rawData.map((row) => {
            const item = {};
            REQUIRED_COLUMNS.forEach((col) => {
                item[col] = row[col] !== undefined ? String(row[col]).trim() : "";
            });
            return item;
        });

        // Xóa file tạm
        fs.unlinkSync(filePath);

        // Lưu vào database (upsert theo SKU)
        const bulkOps = data.map((item) => ({
            updateOne: {
                filter: { SKU: item.SKU },
                update: { $set: item },
                upsert: true,
            },
        }));

        const result = await EtsyListing.bulkWrite(bulkOps);

        return res.status(200).json({
            success: true,
            total: data.length,
            inserted: result.upsertedCount,
            updated: result.modifiedCount,
            data,
        });
    } catch (error) {
        // Xóa file tạm nếu có lỗi
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (_) { }
        }

        console.error("parseEtsyListingFile error:", error);
        return res.status(500).json({
            success: false,
            message: "Lỗi khi xử lý file: " + error.message,
        });
    }
};

module.exports = {
    parseEtsyListingFile,
};
