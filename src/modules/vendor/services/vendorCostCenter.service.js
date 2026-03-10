// src/modules/vendor/services/vendorCostCenter.service.js
const db = require('../../../models');
const VendorCostCenter = db.vendorCostCenter;
const VendorProduct = db.vendorProduct;

// Helpers
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

const getAllVendorCostCenters = async (filters) => {
    const {
        vendor_product,
        status,
        vendor_size,
        vendor_color,
        sku,
        search,
        page = 1,
        perPage = 10
    } = filters;

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

    return { total, page: parseInt(page), perPage: parseInt(perPage), data: items };
};

const getVendorCostCenterById = async (id) => {
    const item = await VendorCostCenter.findById(id).populate('history.updated_by', 'name');
    if (!item) {
        const err = new Error('Vendor Cost Center not found');
        err.status = 404;
        throw err;
    }
    return item;
};

const createVendorCostCenter = async (data) => {
    return await VendorCostCenter.create(data);
};

const updateVendorCostCenter = async (id, data, updatedBy) => {
    const updateData = { ...data };
    if (updatedBy) {
        updateData.$push = { history: { updated_by: updatedBy } };
    }

    const item = await VendorCostCenter.findByIdAndUpdate(id, updateData, { new: true });
    if (!item) {
        const err = new Error('Vendor Cost Center not found');
        err.status = 404;
        throw err;
    }
    return item;
};

const deleteVendorCostCenter = async (id) => {
    const item = await VendorCostCenter.findByIdAndDelete(id);
    if (!item) {
        const err = new Error('Vendor Cost Center not found');
        err.status = 404;
        throw err;
    }
};

const updateVendorCostCenterStatus = async (id, status) => {
    if (!['Active', 'Inactive'].includes(status)) {
        const err = new Error('Invalid status');
        err.status = 400;
        throw err;
    }
    const updated = await VendorCostCenter.findByIdAndUpdate(id, { status }, { new: true });
    if (!updated) {
        const err = new Error('Vendor Cost Center not found');
        err.status = 404;
        throw err;
    }
    return updated;
};

const getCostCentersByVendorProduct = async (vendorProductId) => {
    const vendorProduct = await VendorProduct.findById(vendorProductId);
    if (!vendorProduct) {
        const err = new Error('Vendor Product not found');
        err.status = 404;
        throw err;
    }

    const items = await VendorCostCenter.find({ vendor_product: vendorProductId })
        .populate('history.updated_by', 'name');

    return { vendor_product_name: vendorProduct.product_name || '', items };
};

const importVendorCostCenterFromExcelData = async (vendor_product, jsonData) => {
    if (!vendor_product) {
        const err = new Error('Missing vendor_product');
        err.status = 400;
        throw err;
    }

    if (jsonData.length < 2) {
        const err = new Error('Excel sheet is empty or missing data');
        err.status = 400;
        throw err;
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

    return {
        message: `Imported ${inserted.length} records successfully with additional costs & priority`,
        data: inserted
    };
};

const bulkUpdateVendorCostCenterFromExcelData = async (vendor_product, rows, allowUpsert, dryRun) => {
    if (!vendor_product) {
        const err = new Error('Missing vendor_product');
        err.status = 400;
        throw err;
    }

    const vp = await VendorProduct.findById(vendor_product).lean();
    if (!vp) {
        const err = new Error('Vendor Product not found');
        err.status = 404;
        throw err;
    }

    if (rows.length < 3) {
        const err = new Error('Sheet is empty or missing header');
        err.status = 400;
        throw err;
    }

    const dataRows = rows.slice(2);
    const ops = [];
    const preview = [];
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
            const current = await VendorCostCenter.findOne(filter).lean();
            if (!current && !allowUpsert) {
                preview.push({ action: 'skip (not found)', filter });
                continue;
            }
            if (!current && allowUpsert) {
                preview.push({ action: 'upsert (new)', filter, set: $set });
                continue;
            }

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

            if (Object.keys(diffs).length > 0) {
                preview.push({
                    action: 'update',
                    key: filter,
                    changedFields: Object.keys(diffs),
                    diff: diffs
                });
            } else {
                preview.push({ action: 'skip (no changes)', filter });
            }
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

    if (dryRun) {
        return {
            message: 'Dry run – no changes applied',
            vendor_product,
            total_rows: dataRows.length,
            rows_considered: toProcess,
            preview_count: preview.length,
            preview: preview.slice(0, 50)
        };
    }

    if (ops.length === 0) {
        return { message: 'No valid rows to update', updated: 0, matched: 0, upserted: 0 };
    }

    const result = await VendorCostCenter.bulkWrite(ops, { ordered: false });

    return {
        message: 'Bulk update completed',
        stats: {
            matched: result.matchedCount || result.nMatched || 0,
            updated: result.modifiedCount || result.nModified || 0,
            upserted: result.upsertedCount || result.nUpserted || 0
        },
        allowUpsert
    };
};

module.exports = {
    getAllVendorCostCenters,
    getVendorCostCenterById,
    createVendorCostCenter,
    updateVendorCostCenter,
    deleteVendorCostCenter,
    updateVendorCostCenterStatus,
    getCostCentersByVendorProduct,
    importVendorCostCenterFromExcelData,
    bulkUpdateVendorCostCenterFromExcelData
};

