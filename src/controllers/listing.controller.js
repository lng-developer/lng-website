// controllers/listing.controller.js
const db = require('../models');
const multer = require('multer');
const Listing = db.listing;
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ✅ dùng các helper từ utils/wasabi
const {
    uploadBufferToWasabi,
    getSignedUrlForKey,
    buildPsdKeyFromAsin,
} = require('../utils/wasabi');

// ==============================
// GET list (paging + filter + sort + populate)
// ==============================
const getListings = async (req, res) => {
    try {
        const {
            page = 1,
            perPage = 10,
            asinType,
            seller,
            platform,
            sort = 'createdAt', // createdAt | updatedAt | total_sales | seller_name
            order = 'desc',
            search,
        } = req.query;

        const filter = {};
        if (asinType) filter.asin_type = asinType;
        if (seller) filter.seller = seller;
        if (platform) filter.platform = platform;

        if (search) {
            const regex = new RegExp(search, 'i');
            filter.$or = [{ asin: regex }, { 'template.design_product': regex }];
        }

        const skip = (Number(page) - 1) * Number(perPage);
        const total = await Listing.countDocuments(filter);

        let listings = await Listing.find(filter)
            .sort({ [sort === 'seller_name' ? 'createdAt' : sort]: order === 'asc' ? 1 : -1 })
            .skip(skip)
            .limit(Number(perPage))
            .populate({ path: 'seller', select: 'full_name' })
            .populate({ path: 'store', select: 'name' })
            .lean();

        if (sort === 'seller_name') {
            listings.sort((a, b) => {
                const A = (a.seller_name || '').toString();
                const B = (b.seller_name || '').toString();
                return order === 'asc' ? A.localeCompare(B) : B.localeCompare(A);
            });
        }

        return res.json({ total, listings });
    } catch (error) {
        return res.status(500).json({ message: 'Error fetching listings', error: error.message });
    }
};

// ==============================
// Upsert listing
// ==============================
const upsertListing = async (req, res) => {
    try {
        const data = req.body;
        const updated = await Listing.findOneAndUpdate(
            { asin: data.asin },
            { $set: data },
            { upsert: true, new: true },
        );
        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: 'Error upserting listing', error: error.message });
    }
};

// ==============================
// Multer config (nhận PSD qua RAM)
// ==============================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
    fileFilter: (req, file, cb) => {
        const ok = file.mimetype === 'image/vnd.adobe.photoshop' || /\.psd$/i.test(file.originalname);
        if (!ok) return cb(new Error('Chỉ chấp nhận PSD'));
        cb(null, true);
    },
});

// ==============================
// Upload/Update PSD (overwrite theo ASIN)
// ==============================
const updatePSD = [
    upload.single('file'),
    async (req, res) => {
        try {
            const { asin } = req.params;
            const status = (req.body && req.body.status) === 'Unavailable' ? 'Unavailable' : 'Available';

            if (!asin) return res.status(400).json({ message: 'Thiếu asin' });
            if (!req.file?.buffer) return res.status(400).json({ message: 'Thiếu file PSD (field: file)' });

            // Key cố định theo ASIN: psd/<ASIN>/<ASIN>.psd
            const key = buildPsdKeyFromAsin(asin);

            // Upload (overwrite nếu tồn tại)
            const { url } = await uploadBufferToWasabi(req.file.buffer, {
                key,
                contentType: 'image/vnd.adobe.photoshop',
            });

            const updated = await Listing.findOneAndUpdate(
                { asin },
                {
                    $set: {
                        'psd.psd_id': asin, // trùng ASIN
                        'psd.url': url,     // với bucket private, URL này không tải trực tiếp; dùng signed URL để tải
                        'psd.status': status,
                        date_updated: new Date(),
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );

            return res.json({ message: 'Cập nhật PSD thành công', listing: updated });
        } catch (err) {
            console.error('Error updating PSD:', err);
            return res.status(500).json({ message: 'Error updating PSD', error: err.message });
        }
    },
];

// ==============================
// Lấy signed URL để download PSD
// ==============================
const getPsdSignedUrl = async (req, res) => {
    try {
        const { asin } = req.params;
        const expires = Math.max(60, Math.min(86400, Number(req.query.expires) || 3600)); // 1m–24h
        const asAttachment = String(req.query.download || '') === '1';

        const listing = await Listing.findOne({ asin }).lean();
        if (!listing) return res.status(404).json({ message: 'Listing không tồn tại' });

        // ✅ luôn build key từ ASIN theo quy ước lưu file
        const key = buildPsdKeyFromAsin(asin);

        const filename = `${asin}${path.extname(key) || '.psd'}`;
        const url = await getSignedUrlForKey(key, { expiresIn: expires, asAttachment, filename });

        return res.json({ asin, key, signed_url: url, expires_in: expires });
    } catch (error) {
        console.error('Error getPsdSignedUrl:', error);
        return res.status(500).json({ message: 'Lỗi tạo signed URL', error: error.message });
    }
};

// ==============================
// Delete listing
// ==============================
const deleteListing = async (req, res) => {
    try {
        const { asin } = req.params;
        await Listing.findOneAndDelete({ asin });
        res.json({ message: 'Listing deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting listing', error: error.message });
    }
};

// ==============================
// Excel import
// ==============================
const fieldColumnMapping = {
    asin: 'ASIN',
    product_image: 'Image',
    total_sales: 'Total Sales',
    platform: 'Platform',
    store: 'Store',
    seller: 'Seller',
    thread_color: 'Thread Color',
    thread_note: 'Thread Note',
    asin_type: 'ASIN Type',
    other_config: 'Other Config',

    // Template group
    'template.style': 'Style',
    'template.sub_style': 'Sub Style',
    'template.design_product': 'Design Product',
    'template.variant': 'Variant',

    // PSD group
    'psd.psd_id': 'PSD ID',
    'psd.status': 'PSD Status',
};

const formatColumnName = (fieldName) => fieldColumnMapping[fieldName] || fieldName;

const importListingsFromExcel = async (req, res) => {
    try {
        const filePath = req.file.path;
        const workbook = XLSX.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        const listingsToInsert = [];

        for (const row of rows) {
            const asin = row[formatColumnName('asin')]?.toString().trim();
            if (!asin) continue;

            const newListing = { asin, template: {}, psd: {} };

            const topLevelFields = [
                'product_image',
                'total_sales',
                'platform',
                'store',
                'seller',
                'thread_color',
                'thread_note',
                'asin_type',
                'other_config',
            ];

            const templateFields = ['style', 'sub_style', 'design_product', 'variant'];
            const psdFields = ['psd_id', 'status'];

            topLevelFields.forEach((field) => {
                const col = formatColumnName(field);
                if (row[col] !== undefined) newListing[field] = row[col];
            });

            templateFields.forEach((field) => {
                const col = formatColumnName(`template.${field}`);
                if (row[col] !== undefined) newListing.template[field] = row[col];
            });

            psdFields.forEach((field) => {
                const col = formatColumnName(`psd.${field}`);
                if (row[col] !== undefined) {
                    if (field === 'status') {
                        newListing.psd.status = row[col].toLowerCase() === 'available' ? 'Available' : 'Unavailable';
                    } else {
                        newListing.psd[field] = row[col];
                    }
                }
            });

            newListing.template.variant ||= 'All';
            newListing.psd.status ||= 'Unavailable';
            newListing.platform ||= 'Amazon';
            newListing.total_sales ||= 0;

            listingsToInsert.push(newListing);
        }

        console.log(`✅ Tổng bản ghi sẽ insert: ${listingsToInsert.length}`);
        if (listingsToInsert.length === 0) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ message: 'Không có bản ghi hợp lệ để import' });
        }

        await Listing.insertMany(listingsToInsert, { ordered: false });
        fs.unlinkSync(filePath);

        res.json({ message: 'Import thành công', inserted: listingsToInsert.length });
    } catch (error) {
        console.error('❌ Lỗi import:', error);
        res.status(500).json({ message: 'Lỗi import', error: error.message });
    }
};

module.exports = {
    getListings,
    upsertListing,
    updatePSD,
    deleteListing,
    importListingsFromExcel,
    getPsdSignedUrl,
};
