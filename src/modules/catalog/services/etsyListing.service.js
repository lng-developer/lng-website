// src/modules/catalog/services/etsyListing.service.js
const EtsyListing = require('../models/etsyListing.model');
const XLSX = require("xlsx");

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

const parseEtsyListingFileData = async (filePath) => {
    // Đọc file bằng xlsx (hỗ trợ cả .xlsx, .xls, .csv)
    const workbook = XLSX.readFile(filePath, { type: "file" });

    // Lấy sheet đầu tiên
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        const err = new Error("File không có sheet nào.");
        err.status = 400;
        throw err;
    }

    const sheet = workbook.Sheets[sheetName];

    // Convert sheet sang JSON (header row = key)
    const rawData = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (!rawData || rawData.length === 0) {
        const err = new Error("File không có dữ liệu.");
        err.status = 400;
        throw err;
    }

    // Validate: kiểm tra header có chứa ít nhất TITLE và SKU
    const firstRowKeys = Object.keys(rawData[0]);
    const missingColumns = ["TITLE", "SKU"].filter(
        (col) => !firstRowKeys.includes(col)
    );

    if (missingColumns.length > 0) {
        const err = new Error(`File thiếu các cột bắt buộc: ${missingColumns.join(", ")}`);
        err.status = 400;
        throw err;
    }

    // Extract chỉ các trường cần thiết
    const data = rawData.map((row) => {
        const item = {};
        REQUIRED_COLUMNS.forEach((col) => {
            item[col] = row[col] !== undefined ? String(row[col]).trim() : "";
        });
        return item;
    });

    // Lưu vào database (upsert theo SKU)
    const bulkOps = data.map((item) => ({
        updateOne: {
            filter: { SKU: item.SKU },
            update: { $set: item },
            upsert: true,
        },
    }));

    const result = await EtsyListing.bulkWrite(bulkOps);

    return {
        total: data.length,
        inserted: result.upsertedCount,
        updated: result.modifiedCount,
        data,
    };
};

module.exports = {
    parseEtsyListingFileData,
};

