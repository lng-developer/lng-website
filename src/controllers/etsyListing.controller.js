const XLSX = require("xlsx");
const fs = require("fs");
const mongoose = require("mongoose");
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

const firstNonBlankString = (...values) => {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        const s = String(value).trim();
        if (s) return s;
    }
    return "";
};

const normalizeSkus = (listing) => {
    const candidates = [
        listing?.SKU,
        listing?.sku,
        listing?.product_identifier,
        listing?.productIdentifier,
        ...(Array.isArray(listing?.skus) ? listing.skus : []),
    ];

    return Array.from(new Set(
        candidates
            .map((value) => String(value || "").trim())
            .filter(Boolean)
    ));
};

const normalizeListingMasterRow = (listing) => {
    const listingId = firstNonBlankString(
        listing?.listingId,
        listing?.listing_id,
        listing?.LISTING_ID,
        listing?.["Listing ID"]
    );
    const skus = normalizeSkus(listing);
    const sku = skus[0] || "";
    const title = firstNonBlankString(listing?.title, listing?.TITLE, listing?.name);
    const imageUrl = firstNonBlankString(listing?.imageUrl, listing?.IMAGE1, listing?.image_url, listing?.image);

    return {
        listingId,
        title,
        url: firstNonBlankString(listing?.url, listing?.URL, listing?.listingUrl, listing?.listing_url),
        imageUrl,
        TITLE: title,
        IMAGE1: imageUrl,
        SKU: sku,
        skus,
        skuSource: sku ? "listing_master_sync" : "missing",
        raw: listing,
        syncedAt: new Date(),
    };
};

const syncEtsyListings = async (req, res) => {
    try {
        const {
            shopId,
            etsyShopId,
            shopName,
            listings = [],
        } = req.body || {};

        if (!shopId) {
            return res.status(400).json({ ok: false, message: "shopId is required" });
        }
        if (!mongoose.Types.ObjectId.isValid(shopId)) {
            return res.status(400).json({ ok: false, message: "shopId invalid" });
        }
        if (!Array.isArray(listings)) {
            return res.status(400).json({ ok: false, message: "listings must be an array" });
        }

        const normalized = listings
            .map(normalizeListingMasterRow)
            .filter((listing) => listing.listingId);

        const shopObjectId = new mongoose.Types.ObjectId(shopId);
        const bulkOps = normalized.map((listing) => ({
            updateOne: {
                filter: { shopId: shopObjectId, listingId: listing.listingId },
                update: {
                    $set: {
                        shopId: shopObjectId,
                        etsyShopId: etsyShopId ? String(etsyShopId) : undefined,
                        shopName: shopName ? String(shopName) : undefined,
                        listingId: listing.listingId,
                        title: listing.title,
                        url: listing.url,
                        imageUrl: listing.imageUrl,
                        TITLE: listing.TITLE,
                        IMAGE1: listing.IMAGE1,
                        SKU: listing.SKU,
                        sku: listing.SKU,
                        skus: listing.skus,
                        skuSource: listing.skuSource,
                        raw: listing.raw,
                        syncedAt: listing.syncedAt,
                    },
                },
                upsert: true,
            },
        }));

        const result = bulkOps.length
            ? await EtsyListing.bulkWrite(bulkOps, { ordered: false })
            : { upsertedCount: 0, modifiedCount: 0, matchedCount: 0 };

        return res.json({
            ok: true,
            shopId,
            etsyShopId: etsyShopId || null,
            shopName: shopName || null,
            received: listings.length,
            accepted: normalized.length,
            rejected: listings.length - normalized.length,
            upserted: result.upsertedCount || 0,
            modified: result.modifiedCount || 0,
            matched: result.matchedCount || 0,
        });
    } catch (error) {
        console.error("syncEtsyListings error:", error);
        return res.status(500).json({
            ok: false,
            message: "Sync Etsy listings failed",
            error: error.message,
        });
    }
};

module.exports = {
    parseEtsyListingFile,
    syncEtsyListings,
};
