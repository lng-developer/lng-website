const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const mongoose = require("mongoose");
const EtsyListing = require("../models/etsyListing.model");
const {
    uploadBufferToWasabi,
    getSignedUrlForKey,
    deleteObjectFromWasabi,
} = require("../utils/wasabi");

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

const DESIGN_FILE_MIME_BY_EXT = {
    ".zip": "application/zip",
};

const designFileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ext = (path.extname(file.originalname) || "").toLowerCase();
        if (ext !== ".zip") return cb(new Error("Only .zip files are accepted"));
        cb(null, true);
    },
});

const normalizeListingIdParam = (value) => String(value || "").trim();

const buildEtsyListingDesignFileKey = (listingId, ext = ".zip") => {
    const safeListingId = normalizeListingIdParam(listingId).replace(/[^A-Za-z0-9_.-]/g, "_");
    return `etsy-listings/${safeListingId}/${safeListingId}${ext}`;
};

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

const firstFiniteNumber = (...values) => {
    for (const value of values) {
        if (value == null || value === "") continue;
        const number = typeof value === "number"
            ? value
            : Number(String(value).replace(/[^0-9.-]/g, ""));
        if (Number.isFinite(number)) return number;
    }

    return null;
};

const buildListingImages = (listing) => ([
    listing.imageUrl,
    listing.IMAGE1,
    listing.IMAGE2,
    listing.IMAGE3,
    listing.IMAGE4,
    listing.IMAGE5,
    listing.IMAGE6,
    listing.IMAGE7,
    listing.IMAGE8,
    listing.IMAGE9,
    listing.IMAGE10,
]).map((value) => String(value || "").trim()).filter(Boolean);

const toListingDetailResponse = (listing) => ({
    _id: String(listing._id),
    shopId: listing.shopId ? String(listing.shopId) : "",
    etsyShopId: listing.etsyShopId || "",
    shopName: listing.shopName || "",
    listingId: listing.listingId || "",
    title: listing.title || "",
    SKU: listing.SKU || listing.sku || "",
    PSDstatus: !!listing.PSDstatus,
    designFile: listing.designFile || null,
    imageUrl: buildListingImages(listing)[0] || "",
    img: buildListingImages(listing)[0] || "",
    IMAGE1: listing.IMAGE1 || listing.imageUrl || "",
    images: buildListingImages(listing),
    price: firstFiniteNumber(listing.price, listing.raw?.price, listing.raw?.raw?.price),
    quantity: firstFiniteNumber(listing.quantity, listing.raw?.quantity, listing.raw?.raw?.quantity),
    syncedAt: listing.syncedAt || null,
    updatedAt: listing.updatedAt || null,
});

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parsePositiveInt = (value, fallback, max) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return max ? Math.min(parsed, max) : parsed;
};

const buildEtsyListingQuery = ({ search, stock, shopId } = {}) => {
    const query = {};
    const andConditions = [];
    const searchText = String(search || "").trim();
    const stockFilter = String(stock || "").trim().toLowerCase();
    const shopIdText = String(shopId || "").trim();

    if (shopIdText) {
        if (!mongoose.Types.ObjectId.isValid(shopIdText)) {
            const err = new Error("shopId invalid");
            err.statusCode = 400;
            throw err;
        }
        query.shopId = new mongoose.Types.ObjectId(shopIdText);
    }

    if (searchText) {
        const regex = new RegExp(escapeRegex(searchText), "i");
        andConditions.push({
            $or: [
                { listingId: regex },
                { title: regex },
                { SKU: regex },
                { sku: regex },
                { skus: regex },
                { shopName: regex },
                { etsyShopId: regex },
            ],
        });
    }

    if (stockFilter === "in_stock" || stockFilter === "instock" || stockFilter === "available") {
        andConditions.push({
            $or: [
                { "raw.quantity": { $gt: 0 } },
                { "raw.raw.quantity": { $gt: 0 } },
            ],
        });
    } else if (stockFilter === "out_of_stock" || stockFilter === "outofstock" || stockFilter === "empty") {
        andConditions.push({
            $or: [
                { "raw.quantity": { $lte: 0 } },
                { "raw.raw.quantity": { $lte: 0 } },
                { "raw.quantity": { $exists: false }, "raw.raw.quantity": { $exists: false } },
            ],
        });
    }

    if (andConditions.length) {
        query.$and = andConditions;
    }

    return query;
};

const listEtsyListings = async (req, res) => {
    try {
        const page = parsePositiveInt(req.query?.page, 1);
        const perPage = parsePositiveInt(req.query?.perPage || req.query?.limit, 20, 200);
        const skip = (page - 1) * perPage;
        const query = buildEtsyListingQuery(req.query || {});

        const [listings, total] = await Promise.all([
            EtsyListing.find(query)
                .sort({ updatedAt: -1, _id: -1 })
                .skip(skip)
                .limit(perPage)
                .lean(),
            EtsyListing.countDocuments(query),
        ]);

        return res.json({
            ok: true,
            data: listings.map(toListingDetailResponse),
            pagination: {
                page,
                perPage,
                total,
                totalPages: Math.ceil(total / perPage),
            },
        });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        console.error("listEtsyListings error:", error);
        return res.status(statusCode).json({
            ok: false,
            message: statusCode === 400 ? error.message : "List Etsy listings failed",
            ...(statusCode === 500 ? { error: error.message } : {}),
        });
    }
};

const getEtsyListingDetail = async (req, res) => {
    try {
        const { id } = req.params || {};

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ ok: false, message: "id invalid" });
        }

        const listing = await EtsyListing.findById(id).lean();

        if (!listing) {
            return res.status(404).json({ ok: false, message: "Etsy listing not found" });
        }

        return res.json({
            ok: true,
            data: toListingDetailResponse(listing),
        });
    } catch (error) {
        console.error("getEtsyListingDetail error:", error);
        return res.status(500).json({
            ok: false,
            message: "Get Etsy listing detail failed",
            error: error.message,
        });
    }
};

const uploadEtsyListingDesignFile = [
    designFileUpload.single("file"),
    async (req, res) => {
        try {
            const listingId = normalizeListingIdParam(req.query?.listingId);

            if (!listingId) {
                return res.status(400).json({ ok: false, message: "listingId is required" });
            }
            if (!req.file?.buffer) {
                return res.status(400).json({ ok: false, message: "file is required (field: file)" });
            }

            const existing = await EtsyListing.findOne({ listingId }).lean();
            if (!existing) {
                return res.status(404).json({ ok: false, message: "Etsy listing not found" });
            }

            const originalName = req.file.originalname || `${listingId}.zip`;
            const ext = ".zip";
            const key = buildEtsyListingDesignFileKey(listingId, ext);
            const contentType = DESIGN_FILE_MIME_BY_EXT[ext];
            const uploaded = await uploadBufferToWasabi(req.file.buffer, {
                key,
                contentType,
            });

            const updated = await EtsyListing.findOneAndUpdate(
                { listingId },
                {
                    $set: {
                        "designFile.key": uploaded.key,
                        "designFile.url": uploaded.url,
                        "designFile.fileName": originalName,
                        "designFile.fileExt": ext,
                        "designFile.mime": contentType,
                        "designFile.size": req.file.size || 0,
                        "designFile.uploadedAt": new Date(),
                        PSDstatus: true,
                    },
                },
                { new: true }
            ).lean();

            if (!updated) {
                return res.status(404).json({ ok: false, message: "Etsy listing not found" });
            }

            return res.json({
                ok: true,
                message: "Etsy listing design file uploaded",
                listingId,
                key: uploaded.key,
                item: updated,
            });
        } catch (error) {
            console.error("uploadEtsyListingDesignFile error:", error);
            return res.status(500).json({
                ok: false,
                message: "Upload Etsy listing design file failed",
                error: error.message,
            });
        }
    },
];

const getEtsyListingDesignFileSignedUrl = async (req, res) => {
    try {
        const listingId = normalizeListingIdParam(req.query?.listingId);
        const expires = Math.max(60, Math.min(86400, Number(req.query?.expires) || 3600));
        const asAttachment = String(req.query?.download || "") === "1";

        if (!listingId) {
            return res.status(400).json({ ok: false, message: "listingId is required" });
        }

        const listing = await EtsyListing.findOne({ listingId }).lean();
        if (!listing) {
            return res.status(404).json({ ok: false, message: "Etsy listing not found" });
        }

        const key = String(listing.designFile?.key || "").trim();
        if (!key) {
            return res.status(404).json({ ok: false, message: "Etsy listing design file not found" });
        }

        const ext = String(listing.designFile?.fileExt || ".zip").toLowerCase();
        const filename = `${listingId}${ext}`;
        const signedUrl = await getSignedUrlForKey(key, {
            expiresIn: expires,
            asAttachment,
            filename,
        });

        return res.json({
            ok: true,
            listingId,
            key,
            signed_url: signedUrl,
            expires_in: expires,
        });
    } catch (error) {
        console.error("getEtsyListingDesignFileSignedUrl error:", error);
        return res.status(500).json({
            ok: false,
            message: "Get Etsy listing design file signed URL failed",
            error: error.message,
        });
    }
};

const deleteEtsyListingDesignFile = async (req, res) => {
    try {
        const listingId = normalizeListingIdParam(req.query?.listingId);

        if (!listingId) {
            return res.status(400).json({ ok: false, message: "listingId is required" });
        }

        const listing = await EtsyListing.findOne({ listingId }).lean();
        if (!listing) {
            return res.status(404).json({ ok: false, message: "Etsy listing not found" });
        }

        const key = String(listing.designFile?.key || "").trim();
        if (!key) {
            return res.status(404).json({ ok: false, message: "Etsy listing design file not found" });
        }

        await deleteObjectFromWasabi(key);

        const updated = await EtsyListing.findOneAndUpdate(
            { listingId },
            {
                $set: {
                    "designFile.key": "",
                    "designFile.url": "",
                    "designFile.fileName": "",
                    "designFile.fileExt": ".zip",
                    "designFile.mime": "",
                    "designFile.size": 0,
                    "designFile.uploadedAt": null,
                    PSDstatus: false,
                },
            },
            { new: true }
        ).lean();

        return res.json({
            ok: true,
            message: "Etsy listing design file deleted",
            listingId,
            key,
            item: updated,
        });
    } catch (error) {
        console.error("deleteEtsyListingDesignFile error:", error);
        return res.status(500).json({
            ok: false,
            message: "Delete Etsy listing design file failed",
            error: error.message,
        });
    }
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

const getEtsyListingSyncStatus = async (req, res) => {
    try {
        const { shopId } = req.query || {};

        if (!shopId) {
            return res.status(400).json({ ok: false, message: "shopId is required" });
        }
        if (!mongoose.Types.ObjectId.isValid(shopId)) {
            return res.status(400).json({ ok: false, message: "shopId invalid" });
        }

        const shopObjectId = new mongoose.Types.ObjectId(shopId);
        const [stat] = await EtsyListing.aggregate([
            { $match: { shopId: shopObjectId } },
            {
                $project: {
                    syncedAt: 1,
                    hasSku: {
                        $gt: [
                            {
                                $size: {
                                    $filter: {
                                        input: {
                                            $setUnion: [
                                                [{ $ifNull: ["$SKU", ""] }],
                                                [{ $ifNull: ["$sku", ""] }],
                                                { $ifNull: ["$skus", []] },
                                            ],
                                        },
                                        as: "sku",
                                        cond: {
                                            $gt: [
                                                { $strLenCP: { $trim: { input: { $toString: "$$sku" } } } },
                                                0,
                                            ],
                                        },
                                    },
                                },
                            },
                            0,
                        ],
                    },
                },
            },
            {
                $group: {
                    _id: null,
                    totalListings: { $sum: 1 },
                    listingsWithSku: { $sum: { $cond: ["$hasSku", 1, 0] } },
                    latestSyncedAt: { $max: "$syncedAt" },
                    oldestSyncedAt: { $min: "$syncedAt" },
                },
            },
        ]);

        const totalListings = stat?.totalListings || 0;
        const listingsWithSku = stat?.listingsWithSku || 0;
        const latestSyncedAt = stat?.latestSyncedAt || null;
        const oldestSyncedAt = stat?.oldestSyncedAt || null;
        const ageHours = latestSyncedAt
            ? Number(((Date.now() - new Date(latestSyncedAt).getTime()) / 36e5).toFixed(2))
            : null;

        return res.json({
            ok: true,
            shopId,
            totalListings,
            listingsWithSku,
            listingsMissingSku: Math.max(0, totalListings - listingsWithSku),
            latestSyncedAt,
            oldestSyncedAt,
            ageHours,
            isEmpty: totalListings === 0,
        });
    } catch (error) {
        console.error("getEtsyListingSyncStatus error:", error);
        return res.status(500).json({
            ok: false,
            message: "Get Etsy listing sync status failed",
            error: error.message,
        });
    }
};

module.exports = {
    parseEtsyListingFile,
    syncEtsyListings,
    getEtsyListingSyncStatus,
    getEtsyListingDetail,
    listEtsyListings,
    uploadEtsyListingDesignFile,
    getEtsyListingDesignFileSignedUrl,
    deleteEtsyListingDesignFile,
    buildEtsyListingDesignFileKey,
};
