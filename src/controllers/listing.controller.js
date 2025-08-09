const db = require('../models');
const Listing = db.listing
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
// Lấy danh sách listing (có phân trang + lọc + sort)
const getListings = async (req, res) => {
    try {
        const {
            page = 1,
            perPage = 10,
            asinType,
            seller,
            platform,
            sort = 'createdAt',
            order = 'desc',
            search
        } = req.query;

        const filter = {};

        if (asinType) filter.asin_type = asinType;
        if (seller) filter.seller = seller;
        if (platform) filter.platform = platform;
        if (search) {
            const regex = new RegExp(search, 'i');
            filter.$or = [
                { asin: regex },
                { 'template.design_product': regex }
            ];
        }

        const skip = (page - 1) * perPage;
        const total = await Listing.countDocuments(filter);
        const listings = await Listing.find(filter)
            .sort({ [sort]: order === 'asc' ? 1 : -1 })
            .skip(skip)
            .limit(Number(perPage));

        res.json({ total, listings });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching listings', error: error.message });
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

// Gắn PSD
const updatePSD = async (req, res) => {
    try {
        const { asin } = req.params;
        const { psd_id, status } = req.body;

        const updated = await Listing.findOneAndUpdate(
            { asin },
            { $set: { 'psd.psd_id': psd_id, 'psd.status': status } },
            { new: true }
        );

        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: 'Error updating PSD', error: error.message });
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
    importListingsFromExcel
};
