// src/modules/vendor/controllers/vendorProduct.controller.js
const vendorProductService = require('../services/vendorProduct.service');
const XLSX = require('xlsx');

const getAllVendorProducts = async (req, res, next) => {
    try {
        const result = await vendorProductService.getAllVendorProducts(req.query);
        res.json(result);
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        res.status(500).json({ message: 'Failed to fetch vendor products', error: error.message });
    }
};

const getVendorProductById = async (req, res, next) => {
    try {
        const item = await vendorProductService.getVendorProductById(req.params.id);
        res.json(item);
    } catch (error) {
        next(error);
    }
};

const createVendorProduct = async (req, res, next) => {
    try {
        const item = await vendorProductService.createVendorProduct(req.body);
        res.status(201).json(item);
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        res.status(500).json({ message: 'Failed to create vendor product(s)', error: error.message });
    }
};

const updateVendorProduct = async (req, res, next) => {
    try {
        const item = await vendorProductService.updateVendorProduct(req.params.id, req.body);
        res.json(item);
    } catch (error) {
        next(error);
    }
};

const deleteVendorProduct = async (req, res, next) => {
    try {
        await vendorProductService.deleteVendorProduct(req.params.id);
        res.status(204).send();
    } catch (error) {
        next(error);
    }
};

const getVendorProductsByVendorId = async (req, res, next) => {
    try {
        const data = await vendorProductService.getVendorProductsByVendorId(req.params.vendorId);
        res.status(200).json(data);
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        res.status(500).json({ message: 'Failed to fetch vendor products', error: error.message });
    }
};

const importVendorProductFromExcel = async (req, res, next) => {
    try {
        if (!req.file?.buffer) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        const result = await vendorProductService.importVendorProductFromExcel(req.body.vendor_id, rawData);
        res.status(201).json(result);
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        res.status(500).json({ message: 'Failed to import vendor products', error: error.message });
    }
};

module.exports = {
    getAllVendorProducts,
    getVendorProductById,
    createVendorProduct,
    updateVendorProduct,
    deleteVendorProduct,
    getVendorProductsByVendorId,
    importVendorProductFromExcel
};

