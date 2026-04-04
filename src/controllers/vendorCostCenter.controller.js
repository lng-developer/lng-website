// controllers/vendorCostCenter.controller.js
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const db = require('../models');
const VendorCostCenter = db.vendorCostCenter;
const VendorProduct = db.vendorProduct

// ==============================
// Helpers
// ==============================
const num = (v) => {
    if (v === null || v === undefined) return 0;
    const n = parseFloat(String(v).replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : 0;
};
const str = (v) => String(v ?? '').trim();
const ucStatus = (s) => (String(s || '').toLowerCase() === 'inactive' ? 'Inactive' : 'Active');

const makeFilter = (vendor_product, sku, size, color) => {
    const f = { vendor_product };
    if (str(sku)) f.sku = str(sku);
    if (str(size)) f.vendor_size = str(size);
    if (str(color)) f.vendor_color = str(color);
    return f;
};

// ==============================
// GET all vendor cost centers
// ==============================
const getAllVendorCostCenters = async (req, res) => {
    try {
        const {
            vendor_product,
            status,
            vendor_size,
            vendor_color,
            sku,
            search,         // search keyword for sku/size/color
            page = 1,
            perPage = 10
        } = req.query;

        const filter = {};

        if (vendor_product) filter.vendor_product = vendor_product;
        if (status) filter.status = status;
        if (vendor_size) filter.vendor_size = vendor_size;
        if (vendor_color) filter.vendor_color = vendor_color;
        if (sku) filter.sku = sku;

        if (search) {
            const regex = new RegExp(search, 'i');
            filter.$or = [{ sku: regex }, { vendor_size: regex }, { vendor_color: regex }];
        }

        const skip = (parseInt(page) - 1) * parseInt(perPage);
        const limit = parseInt(perPage);

        const [total, items] = await Promise.all([
            VendorCostCenter.countDocuments(filter),
            VendorCostCenter.find(filter)
                .populate('history.updated_by', 'name')
                .sort({ created_at: -1 })
                .skip(skip)
                .limit(limit)
        ]);

        res.json({ total, page: parseInt(page), perPage: parseInt(perPage), data: items });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ==============================
// GET single vendor cost center by ID
// ==============================
const getVendorCostCenterById = async (req, res) => {
    try {
        const item = await VendorCostCenter.findById(req.params.id).populate('history.updated_by', 'name');
        if (!item) return res.status(404).json({ message: 'Vendor Cost Center not found' });
        res.json(item);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ==============================
// POST create new vendor cost center
// ==============================
const createVendorCostCenter = async (req, res) => {
    try {
        const item = await VendorCostCenter.create(req.body);
        res.status(201).json(item);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// ==============================
// PUT update vendor cost center
// ==============================
const updateVendorCostCenter = async (req, res) => {
    try {
        const item = await VendorCostCenter.findByIdAndUpdate(
            req.params.id,
            { ...req.body, $push: { history: { updated_by: req.body.updated_by } } },
            { new: true }
        );
        if (!item) return res.status(404).json({ message: 'Vendor Cost Center not found' });
        res.json(item);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// ==============================
// DELETE vendor cost center
// ==============================
const deleteVendorCostCenter = async (req, res) => {
    try {
        const item = await VendorCostCenter.findByIdAndDelete(req.params.id);
        if (!item) return res.status(404).json({ message: 'Vendor Cost Center not found' });
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ==============================
// POST update status
// ==============================
const updateVendorCostCenterStatus = async (req, res) => {
    try {
        const { id, status } = req.body;
        if (!['Active', 'Inactive'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }
        const updated = await VendorCostCenter.findByIdAndUpdate(id, { status }, { new: true });
        if (!updated) return res.status(404).json({ message: 'Vendor Cost Center not found' });
        res.json(updated);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// ==============================
// GET cost centers by vendor product ID
// ==============================
const getCostCentersByVendorProduct = async (req, res) => {
    try {
        const { vendorProductId } = req.params;

        const vendorProduct = await VendorProduct.findById(vendorProductId);
        if (!vendorProduct) return res.status(404).json({ message: 'Vendor Product not found' });

        const items = await VendorCostCenter.find({ vendor_product: vendorProductId })
            .populate('history.updated_by', 'name');

        res.json({ vendor_product_name: vendorProduct.product_name || '', items });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ==============================
// GET structured sizes, colors, and prices for Frontend Selection UI
// ==============================
const getVendorProductVariants = async (req, res) => {
    try {
        const { vendorProductId } = req.params;

        const variants = await VendorCostCenter.find({ 
            vendor_product: vendorProductId, 
            status: { $in: ['Active', 'active', null] }
        }).lean();

        // Trích xuất danh sách Size và Color duy nhất không trùng lặp
        const sizes = [...new Set(variants.map(v => v.vendor_size).filter(Boolean))];
        const colors = [...new Set(variants.map(v => v.vendor_color).filter(Boolean))];

        // Tạo Dictionary Map cho Base Cost và thông tin theo cấu trúc [Size_Color]
        // Ví dụ: pricingMap["S_Red"] = { base_cost: 15, sku: "SP1" }
        const pricingMap = {};
        variants.forEach(v => {
            const key = `${v.vendor_size}_${v.vendor_color}`;
            pricingMap[key] = {
                base_cost: v.base_cost || 0,
                sku: v.sku,
                cost_center_id: v._id
            };
        });

        res.json({ sizes, colors, pricingMap });
    } catch (error) {
        console.error('❌ getVendorProductVariants Error:', error);
        res.status(500).json({ message: error.message });
    }
};

// ==============================
// IMPORT (create) from Excel – giữ nguyên như cũ (nếu bạn vẫn cần)
// ==============================
const importVendorCostCenterFromExcel = async (req, res) => {
    try {
        const file = req.file;
        const { vendor_product } = req.body;

        if (!file || !vendor_product) {
            return res.status(400).json({ message: 'Missing file or vendor_product' });
        }

        const workbook = XLSX.readFile(file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        if (jsonData.length < 2) {
            fs.unlink(file.path, () => { });
            return res.status(400).json({ message: 'Excel sheet is empty or missing data' });
        }

        const rows = jsonData.slice(2); // bỏ 2 dòng tiêu đề

        const inserted = [];

        for (const row of rows) {
            if (!row || row.length < 7) continue;

            const product_code = str(row[1]);
            const vendor_size = str(row[2]);
            const vendor_color = str(row[3]);
            const product_type_design = str(row[4]);
            const statusRaw = str(row[5]).toLowerCase() || 'active';

            const base_cost = num(row[6]);
            const domestic_economy = num(row[7]);
            const domestic_additional = num(row[8]);
            const intl_economy = num(row[9]);
            const intl_additional = num(row[10]);

            const embroidery_cost = num(row[11]);
            const two_sided_print_cost = num(row[12]);
            const two_position_print_cost = num(row[13]);

            const priority_economy = num(row[14]);
            const priority_additional = num(row[15]);

            const sizeVal = vendor_size || '';
            const colorVal = vendor_color || '';

            const doc = new VendorCostCenter({
                vendor_product,
                vendor_size: sizeVal,
                vendor_color: colorVal,
                standard_size: sizeVal,
                standard_color: colorVal,
                sku: product_code,
                base_cost,
                dosmetic: { economy: domestic_economy, additional: domestic_additional },
                international: { economy: intl_economy, additional: intl_additional },
                priority: { economy: priority_economy, additional: priority_additional },
                additional_costs: {
                    embroidery: embroidery_cost,
                    two_sided_print: two_sided_print_cost,
                    two_position_print: two_position_print_cost
                },
                product_type_design,
                status: ucStatus(statusRaw)
            });

            await doc.save();
            inserted.push(doc);
        }

        fs.unlink(file.path, () => { });

        return res.status(201).json({
            message: `Imported ${inserted.length} records successfully with additional costs & priority`,
            data: inserted
        });
    } catch (error) {
        console.error('❌ Import Error:', error);
        try { if (req.file?.path) fs.unlink(req.file.path, () => { }); } catch (_) { }
        res.status(500).json({ message: 'Failed to import Excel data', error: error.message });
    }
};

// ==============================
// BULK UPDATE from Excel
// - Dùng chính file để cập nhật các thay đổi
// - Mặc định chỉ update (không tạo mới); có thể bật ?upsert=true
// - Hỗ trợ ?dryRun=true để xem trước và trả về các field khác biệt
// ==============================
const bulkUpdateVendorCostCenterFromExcel = async (req, res) => {
    try {
        const file = req.file;
        const { vendor_product } = req.body;
        const allowUpsert = String(req.query.upsert || 'false').toLowerCase() === 'true';
        const dryRun = String(req.query.dryRun || 'false').toLowerCase() === 'true';

        if (!file || !vendor_product) {
            return res.status(400).json({ message: 'Missing file or vendor_product' });
        }

        // Optional: xác nhận vendor_product tồn tại
        const vp = await VendorProduct.findById(vendor_product).lean();
        if (!vp) {
            fs.unlink(file.path, () => { });
            return res.status(404).json({ message: 'Vendor Product not found' });
        }

        const workbook = XLSX.readFile(file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        if (rows.length < 3) {
            fs.unlink(file.path, () => { });
            return res.status(400).json({ message: 'Sheet is empty or missing header' });
        }

        // Bỏ 2 dòng tiêu đề
        const dataRows = rows.slice(2);

        const ops = [];
        const preview = []; // cho dryRun
        let toProcess = 0;

        for (const row of dataRows) {
            if (!row || row.length < 7) continue;

            const product_code = str(row[1]);
            const vendor_size = str(row[2]);
            const vendor_color = str(row[3]);
            const product_type_design = str(row[4]);
            const statusRaw = str(row[5]).toLowerCase() || 'active';

            const base_cost = num(row[6]);
            const domestic_economy = num(row[7]);
            const domestic_additional = num(row[8]);
            const intl_economy = num(row[9]);
            const intl_additional = num(row[10]);

            const embroidery_cost = num(row[11]);
            const two_sided_print_cost = num(row[12]);
            const two_position_print_cost = num(row[13]);

            const priority_economy = num(row[14]);
            const priority_additional = num(row[15]);

            const sizeVal = vendor_size || '';
            const colorVal = vendor_color || '';


            const filter = makeFilter(vendor_product, product_code, vendor_size, vendor_color);

            const $set = {
                vendor_product,
                vendor_size: sizeVal,
                vendor_color: colorVal,
                standard_size: sizeVal,
                standard_color: colorVal,
                sku: product_code,
                base_cost,
                dosmetic: { economy: domestic_economy, additional: domestic_additional },
                international: { economy: intl_economy, additional: intl_additional },
                priority: { economy: priority_economy, additional: priority_additional },
                additional_costs: {
                    embroidery: embroidery_cost,
                    two_sided_print: two_sided_print_cost,
                    two_position_print: two_position_print_cost
                },
                product_type_design,
                status: ucStatus(statusRaw)
            };

            toProcess++;

            if (dryRun) {
                // So sánh với DB để xem thay đổi
                const current = await VendorCostCenter.findOne(filter).lean();
                if (!current && !allowUpsert) {
                    preview.push({ action: 'skip (not found)', filter });
                    continue;
                }
                if (!current && allowUpsert) {
                    preview.push({ action: 'upsert (new)', filter, set: $set });
                    continue;
                }

                // diff đơn giản
                const diffs = {};
                const flatCompare = {
                    sku: $set.sku,
                    base_cost: $set.base_cost,
                    status: $set.status,
                    product_type_design: $set.product_type_design,
                    'dosmetic.economy': $set.dosmetic.economy,
                    'dosmetic.additional': $set.dosmetic.additional,
                    'international.economy': $set.international.economy,
                    'international.additional': $set.international.additional,
                    'priority.economy': $set.priority.economy,
                    'priority.additional': $set.priority.additional,
                    'additional_costs.embroidery': $set.additional_costs.embroidery,
                    'additional_costs.two_sided_print': $set.additional_costs.two_sided_print,
                    'additional_costs.two_position_print': $set.additional_costs.two_position_print
                };
                const getter = (obj, path) =>
                    path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);

                Object.keys(flatCompare).forEach(key => {
                    const newVal = flatCompare[key];
                    const oldVal = getter(current || {}, key);
                    if (Number.isFinite(newVal) && Number.isFinite(oldVal)) {
                        if (Number(oldVal) !== Number(newVal)) diffs[key] = { from: oldVal, to: newVal };
                    } else if (String(oldVal ?? '') !== String(newVal ?? '')) {
                        diffs[key] = { from: oldVal, to: newVal };
                    }
                });

                preview.push({
                    action: 'update',
                    key: filter,
                    changedFields: Object.keys(diffs),
                    diff: diffs
                });
            } else {
                ops.push({
                    updateOne: {
                        filter,
                        update: { $set },
                        upsert: !!allowUpsert
                    }
                });
            }
        }

        fs.unlink(file.path, () => { });

        if (dryRun) {
            return res.json({
                message: 'Dry run – no changes applied',
                vendor_product,
                total_rows: dataRows.length,
                rows_considered: toProcess,
                preview_count: preview.length,
                preview: preview.slice(0, 50) // limit trả về
            });
        }

        if (ops.length === 0) {
            return res.json({ message: 'No valid rows to update', updated: 0, matched: 0, upserted: 0 });
        }

        const result = await VendorCostCenter.bulkWrite(ops, { ordered: false });

        const updated = result.modifiedCount || result.nModified || 0;
        const matched = result.matchedCount || result.nMatched || 0;
        const upserted = result.upsertedCount || result.nUpserted || 0;

        return res.status(200).json({
            message: 'Bulk update completed',
            stats: { matched, updated, upserted },
            allowUpsert
        });
    } catch (error) {
        console.error('❌ Bulk Update Error:', error);
        try { if (req.file?.path) fs.unlink(req.file.path, () => { }); } catch (_) { }
        res.status(500).json({ message: 'Failed to bulk update Vendor Cost Centers', error: error.message });
    }
};

/**
 * GET /api/vendor-cost-centers/manual-search
 * Tra cứu giá vendor dựa trên tên sản phẩm (fuzzy), size (exact) và color (exact).
 */
const manualSearchVendorCosts = async (req, res) => {
    try {
        const { product_name, size, color } = req.query;

        const pipeline = [
            // 1. Join với VendorProduct
            {
                $lookup: {
                    from: 'vendorproducts',
                    localField: 'vendor_product',
                    foreignField: '_id',
                    as: 'product'
                }
            },
            { $unwind: '$product' },
            // 2. Join với Vendor
            {
                $lookup: {
                    from: 'vendors',
                    localField: 'product.vendor_id',
                    foreignField: '_id',
                    as: 'vendor'
                }
            },
            { $unwind: '$vendor' }
        ];

        const match = {
            status: { $in: ['Active', 'active', null] }
        };

        if (product_name) {
            match['product.product_name'] = { $regex: product_name, $options: 'i' };
        }
        if (size) {
            match.vendor_size = new RegExp(`^${size}$`, 'i'); // Khớp linh hoạt ignore-case
        }
        if (color) {
            match.vendor_color = new RegExp(`^${color}$`, 'i'); // Khớp linh hoạt ignore-case
        }

        pipeline.push({ $match: match });

        pipeline.push({
            $project: {
                _id: 1,
                vendor_product: 1,
                vendor_size: 1,
                vendor_color: 1,
                base_cost: 1,
                sku: 1,
                product_name: '$product.product_name',
                image: '$product.image',
                vendor_name: '$vendor.name',
                vendor_id: '$vendor._id'
            }
        });

        const results = await VendorCostCenter.aggregate(pipeline);
        //count results
        const count = await VendorCostCenter.countDocuments(match);
        res.json({ total: count, results });
    } catch (error) {
        console.error('❌ manualSearchVendorCosts Error:', error);
        res.status(500).json({ message: error.message });
    }
};

const getListVendorProduct = async (req, res) => {
    try {
        const { search, vendor_id, limit, page = 1 } = req.query;
        const mongoose = require('mongoose');

        const pipeline = [];

        // 1. Lọc cơ bản theo trạng thái (và vendor_id nếu có)
        const matchStage = { status: { $in: ['Active', 'active', null] } };
        if (vendor_id && mongoose.Types.ObjectId.isValid(vendor_id)) {
            matchStage.vendor_id = new mongoose.Types.ObjectId(vendor_id);
        }
        pipeline.push({ $match: matchStage });

        // 2. Lookup để lấy tên Vendor hỗ trợ tìm kiếm linh hoạt
        pipeline.push({
            $lookup: {
                from: 'vendors',
                localField: 'vendor_id',
                foreignField: '_id',
                as: 'vendor'
            }
        });
        pipeline.push({
            $unwind: {
                path: '$vendor',
                preserveNullAndEmptyArrays: true
            }
        });

        // 3. Search Engine linh hoạt (tìm theo tên, mã sản phẩm, hãng)
        if (search) {
            const regex = new RegExp(search, 'i');
            pipeline.push({
                $match: {
                    $or: [
                        { product_name: regex },
                        { product_id: regex },
                        { 'vendor.name': regex }
                    ]
                }
            });
        }

        // 4. Sort mặc định theo tên sản phẩm
        pipeline.push({ $sort: { product_name: 1 } });

        // 5. Chuẩn bị pipeline phân trang hoặc không phân trang
        if (limit) {
            const parsedLimit = parseInt(limit);
            const skip = (parseInt(page) - 1) * parsedLimit;
            pipeline.push({
                $facet: {
                    metadata: [{ $count: "total" }],
                    data: [{ $skip: skip }, { $limit: parsedLimit }]
                }
            });
        }

        const aggregateResults = await VendorProduct.aggregate(pipeline);

        // Format lại cho chuẩn xác với `.populate('vendor_id', 'name')`
        const formatItem = (item) => ({
            _id: item._id,
            product_name: item.product_name,
            product_id: item.product_id,
            status: item.status,
            vendor_id: item.vendor ? { _id: item.vendor._id, name: item.vendor.name } : null,
            display_name: `${item.vendor?.name || 'Unknown Vendor'} - ${item.product_name} - ${item.product_id}`
        });

        // Xử lý kết quả trả về: hỗ trợ phân trang nếu có gửi kèm limit, ngược lại trả về list cơ bản bảo toàn tính tương thích cũ
        if (limit) {
            const resultObj = aggregateResults[0];
            const total = resultObj.metadata[0] ? resultObj.metadata[0].total : 0;
            const data = resultObj.data.map(formatItem);
            return res.json({ total, page: parseInt(page), limit: parseInt(limit), data });
        } else {
            const data = aggregateResults.map(formatItem);
            return res.json(data);
        }
    } catch (error) {
        console.error('❌ getListVendorProduct Error:', error);
        res.status(500).json({ message: error.message });
    }
}

/**
 * Lấy chính xác 1 Vendor Cost Center dựa trên VendorProductId, Size và Color
 * Dành cho Frontend xử lý từng tương tác lẻ (Thay vì fetch cả pricingMap)
 */
const lookupSpecificVariant = async (req, res) => {
    try {
        const { vendorProductId } = req.params;
        const { size, color } = req.query;

        if (!vendorProductId) {
            return res.status(400).json({ message: "Thiếu vendorProductId" });
        }

        const sizeVal = size || "";
        const colorVal = color || "";

        // TÌM KIẾM 1: Khớp chính xác hoàn toàn (kể cả rỗng)
        let costCenter = await VendorCostCenter.findOne({
            vendor_product: vendorProductId,
            vendor_size: sizeVal,
            vendor_color: colorVal,
            status: { $in: ['Active', 'active', null] }
        })
        .select('base_cost sku standard_size standard_color vendor_size vendor_color international priority additional_costs')
        .lean();

        // TÌM KIẾM 2: Tìm linh hoạt (IgnoreCase & bỏ qua tham số rỗng)
        if (!costCenter && (sizeVal || colorVal)) {
            const flexibleQuery = {
                vendor_product: vendorProductId,
                status: { $in: ['Active', 'active', null] }
            };
            if (sizeVal) flexibleQuery.vendor_size = new RegExp(`^${sizeVal}$`, "i");
            if (colorVal) flexibleQuery.vendor_color = new RegExp(`^${colorVal}$`, "i");
            
            costCenter = await VendorCostCenter.findOne(flexibleQuery)
                .select('base_cost sku standard_size standard_color vendor_size vendor_color international priority additional_costs')
                .lean();
        }

        // TÌM KIẾM 3: Thử tìm theo standard_size / standard_color nếu vendor_size/color không tìm ra
        if (!costCenter && (sizeVal || colorVal)) {
            const standardQuery = {
                vendor_product: vendorProductId,
                status: { $in: ['Active', 'active', null] }
            };
            if (sizeVal) standardQuery.standard_size = new RegExp(`^${sizeVal}$`, "i");
            if (colorVal) standardQuery.standard_color = new RegExp(`^${colorVal}$`, "i");
            
            costCenter = await VendorCostCenter.findOne(standardQuery)
                .select('base_cost sku standard_size standard_color vendor_size vendor_color international priority additional_costs')
                .lean();
        }

        // TÌM KIẾM 4: Fallback cực đại (Lấy biến thể đầu tiên làm mẫu nếu sản phẩm này ko có size/color giống order)
        if (!costCenter) {
            costCenter = await VendorCostCenter.findOne({
                vendor_product: vendorProductId,
                status: { $in: ['Active', 'active', null] }
            })
            .select('base_cost sku standard_size standard_color vendor_size vendor_color international priority additional_costs')
            .lean();
        }

        if (!costCenter) {
            return res.status(404).json({ message: "Không tìm thấy Cost Center cho biến thể này" });
        }

        return res.json(costCenter);
    } catch (error) {
        console.error('❌ lookupSpecificVariant Error:', error);
        res.status(500).json({ message: error.message });
    }
}

module.exports = {
    getAllVendorCostCenters,
    getVendorCostCenterById,
    createVendorCostCenter,
    updateVendorCostCenter,
    deleteVendorCostCenter,
    updateVendorCostCenterStatus,
    getCostCentersByVendorProduct,
    getVendorProductVariants,
    lookupSpecificVariant,
    importVendorCostCenterFromExcel,
    bulkUpdateVendorCostCenterFromExcel,
    manualSearchVendorCosts,
    getListVendorProduct
};
