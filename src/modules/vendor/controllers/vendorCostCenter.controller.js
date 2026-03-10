// src/modules/vendor/controllers/vendorCostCenter.controller.js
const vendorCostCenterService = require('../services/vendorCostCenter.service');
const XLSX = require('xlsx');
const fs = require('fs');

const getAllVendorCostCenters = async (req, res, next) => {
    try {
        const result = await vendorCostCenterService.getAllVendorCostCenters(req.query);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

const getVendorCostCenterById = async (req, res, next) => {
    try {
        const item = await vendorCostCenterService.getVendorCostCenterById(req.params.id);
        res.json(item);
    } catch (error) {
        if (error.status === 404) {
            return res.status(404).json({ message: error.message });
        }
        next(error);
    }
};

const createVendorCostCenter = async (req, res, next) => {
    try {
        const item = await vendorCostCenterService.createVendorCostCenter(req.body);
        res.status(201).json(item);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const updateVendorCostCenter = async (req, res, next) => {
    try {
        const item = await vendorCostCenterService.updateVendorCostCenter(req.params.id, req.body, req.body.updated_by);
        res.json(item);
    } catch (error) {
        if (error.status === 404) {
            return res.status(404).json({ message: error.message });
        }
        res.status(400).json({ message: error.message });
    }
};

const deleteVendorCostCenter = async (req, res, next) => {
    try {
        await vendorCostCenterService.deleteVendorCostCenter(req.params.id);
        res.status(204).send();
    } catch (error) {
        if (error.status === 404) {
            return res.status(404).json({ message: error.message });
        }
        next(error);
    }
};

const updateVendorCostCenterStatus = async (req, res, next) => {
    try {
        const { id, status } = req.body;
        const updated = await vendorCostCenterService.updateVendorCostCenterStatus(id, status);
        res.json(updated);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const getCostCentersByVendorProduct = async (req, res, next) => {
    try {
        const result = await vendorCostCenterService.getCostCentersByVendorProduct(req.params.vendorProductId);
        res.json(result);
    } catch (error) {
        if (error.status === 404) {
            return res.status(404).json({ message: error.message });
        }
        next(error);
    }
};

const importVendorCostCenterFromExcel = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'Missing file' });
        }

        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        const result = await vendorCostCenterService.importVendorCostCenterFromExcelData(req.body.vendor_product, jsonData);

        fs.unlink(req.file.path, () => { });
        return res.status(201).json(result);
    } catch (error) {
        console.error('❌ Import Error:', error);
        try { if (req.file?.path) fs.unlink(req.file.path, () => { }); } catch (_) { }
        res.status(error.status || 500).json({ message: 'Failed to import Excel data', error: error.message });
    }
};

const bulkUpdateVendorCostCenterFromExcel = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'Missing file' });
        }

        const allowUpsert = String(req.query.upsert || 'false').toLowerCase() === 'true';
        const dryRun = String(req.query.dryRun || 'false').toLowerCase() === 'true';

        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        const result = await vendorCostCenterService.bulkUpdateVendorCostCenterFromExcelData(
            req.body.vendor_product,
            rows,
            allowUpsert,
            dryRun
        );

        fs.unlink(req.file.path, () => { });
        return res.status(200).json(result);
    } catch (error) {
        console.error('❌ Bulk Update Error:', error);
        try { if (req.file?.path) fs.unlink(req.file.path, () => { }); } catch (_) { }
        res.status(error.status || 500).json({ message: 'Failed to bulk update Vendor Cost Centers', error: error.message });
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

