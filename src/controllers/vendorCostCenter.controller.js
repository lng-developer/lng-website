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

            if (!vendor_size || !vendor_color) continue;

            const doc = new VendorCostCenter({
                vendor_product,
                vendor_size,
                vendor_color,
                standard_size: vendor_size,
                standard_color: vendor_color,
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

            if (!vendor_size || !vendor_color) continue;

            const filter = makeFilter(vendor_product, product_code, vendor_size, vendor_color);

            const $set = {
                vendor_product,
                vendor_size,
                vendor_color,
                standard_size: vendor_size,
                standard_color: vendor_color,
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

module.exports = {
    getAllVendorCostCenters,
    getVendorCostCenterById,
    createVendorCostCenter,
    updateVendorCostCenter,
    deleteVendorCostCenter,
    updateVendorCostCenterStatus,
    getCostCentersByVendorProduct,
    importVendorCostCenterFromExcel,
    bulkUpdateVendorCostCenterFromExcel
};
