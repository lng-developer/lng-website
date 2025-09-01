const db = require('../models');
const multer = require("multer")
const Listing = db.listing
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { uploadBufferToWasabi, getSignedUrlForKey } = require('../utils/wasabi'); // ✅ đường dẫn từ controllers → utils

// Lấy danh sách listing (có phân trang + lọc + sort + populate tên seller/store)
const getListings = async (req, res) => {
    try {
        const {
            page = 1,
            perPage = 10,
            asinType,
            seller,
            platform,
            sort = 'createdAt',   // có thể: createdAt | updatedAt | total_sales | seller_name
            order = 'desc',
            search
        } = req.query;

        const filter = {};
        if (asinType) filter.asin_type = asinType;
        if (seller) filter.seller = seller;           // ObjectId của User
        if (platform) filter.platform = platform;

        if (search) {
            const regex = new RegExp(search, 'i');
            filter.$or = [
                { asin: regex },
                { 'template.design_product': regex }
            ];
        }

        const skip = (Number(page) - 1) * Number(perPage);
        const total = await Listing.countDocuments(filter);

        // NOTE: dùng populate + lean để trả seller.name nhẹ hơn
        let listings = await Listing.find(filter)
            .sort({ [sort === 'seller_name' ? 'createdAt' : sort]: order === 'asc' ? 1 : -1 }) // tạm sort theo createdAt nếu sort=seller_name (sẽ sort lại sau)
            .skip(skip)
            .limit(Number(perPage))
            .populate({ path: 'seller', select: 'full_name' })
            .populate({ path: 'store', select: 'name' })
            .lean();

        // Nếu client yêu cầu sort theo seller_name thì sort sau populate
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

// Tạo mới hoặc cập nhật listing
const upsertListing = async (req, res) => {
    try {
        const data = req.body;
        const updated = await Listing.findOneAndUpdate(
            { asin: data.asin },
            { $set: data },
            { upsert: true, new: true }
        );
        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: 'Error upserting listing', error: error.message });
    }
};

// Multer dùng bộ nhớ (RAM) để giữ file upload

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'image/vnd.adobe.photoshop' || /\.psd$/i.test(file.originalname);
    if (!ok) return cb(new Error('Chỉ chấp nhận PSD'));
    cb(null, true);
  }
});


function buildPsdKeyFromAsin(asin) {
    const safeAsin = asin.replace(/[^A-Za-z0-9_\-\.]/g, '_');
    return `psd/${safeAsin}/${asin}.psd`;   // => tên file trên Wasabi = <ASIN>.psd
}

const updatePSD = [
    upload.single('file'),
    async (req, res) => {
        try {
            const { asin } = req.params;
            const { status } = req.body;

            if (!asin) return res.status(400).json({ message: 'Thiếu asin' });
            if (!req.file?.buffer) return res.status(400).json({ message: 'Thiếu file PSD (field: file)' });

            const key = buildPsdKeyFromAsin(asin); // cố định theo ASIN

            // Upload (overwrite nếu tồn tại)
            const { url } = await uploadBufferToWasabi(req.file.buffer, {
                key,
                contentType: 'image/vnd.adobe.photoshop'
            });

            const updated = await Listing.findOneAndUpdate(
                { asin },
                {
                    $set: {
                        asin,
                        'psd.psd_id': asin,                                     // ✅ trùng ASIN
                        'psd.url': url,                                         // với bucket private có thể để trống và chỉ dùng signed URL
                        'psd.status': status === 'Unavailable' ? 'Unavailable' : 'Available',
                        date_updated: new Date()
                    }
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            return res.json({ message: 'Cập nhật PSD thành công', listing: updated });
        } catch (err) {
            console.error('Error updating PSD:', err);
            return res.status(500).json({ message: 'Error updating PSD', error: err.message });
        }
    }
];

const getPsdSignedUrl = async (req, res) => {
    try {
        const { asin } = req.params;
        const expires = Math.max(60, Math.min(86400, Number(req.query.expires) || 3600)); // 1m–24h
        const asAttachment = String(req.query.download || '') === '1';

        const listing = await Listing.findOne({ asin }).lean();
        if (!listing) return res.status(404).json({ message: 'Listing không tồn tại' });

        const key = listing?.psd?.psd_id;
        if (!key) return res.status(400).json({ message: 'Listing chưa có PSD' });

        // đặt tên file tải về đẹp hơn (nếu có)
        const filename = `${asin}${path.extname(key) || '.psd'}`;

        const url = await getSignedUrlForKey(key, { expiresIn: expires, asAttachment, filename });
        return res.json({ asin, key, signed_url: url, expires_in: expires });
    } catch (error) {
        console.error('Error getPsdSignedUrl:', error);
        return res.status(500).json({ message: 'Lỗi tạo signed URL', error: error.message });
    }
};

// Xoá listing
const deleteListing = async (req, res) => {
    try {
        const { asin } = req.params;
        await Listing.findOneAndDelete({ asin });
        res.json({ message: 'Listing deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting listing', error: error.message });
    }
};
// Map giữa field trong MongoDB <=> Tên cột trong Excel
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

// Trả về tên cột tương ứng trong Excel
const formatColumnName = (fieldName) => {
    return fieldColumnMapping[fieldName] || fieldName;
};

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

            const newListing = {
                asin,
                template: {},
                psd: {},
            };

            // Các trường cấp 1
            const topLevelFields = [
                'product_image', 'total_sales', 'platform',
                'store', 'seller', 'thread_color', 'thread_note',
                'asin_type', 'other_config'
            ];

            // Template
            const templateFields = ['style', 'sub_style', 'design_product', 'variant'];
            const psdFields = ['psd_id', 'status'];

            topLevelFields.forEach(field => {
                const col = formatColumnName(field);
                if (row[col] !== undefined) {
                    newListing[field] = row[col];
                }
            });

            templateFields.forEach(field => {
                const col = formatColumnName(`template.${field}`);
                if (row[col] !== undefined) {
                    newListing.template[field] = row[col];
                }
            });

            psdFields.forEach(field => {
                const col = formatColumnName(`psd.${field}`);
                if (row[col] !== undefined) {
                    if (field === 'status') {
                        newListing.psd.status = row[col].toLowerCase() === 'available' ? 'Available' : 'Unavailable';
                    } else {
                        newListing.psd[field] = row[col];
                    }
                }
            });

            // Mặc định fallback
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
    getPsdSignedUrl
};
