// src/modules/catalog/services/skuMappingConfig.service.js
const SkuMappingConfig = require("../models/skuMappingConfig.model");

const createConfig = async (configData, user) => {
    return await SkuMappingConfig.create({
        ...configData,
        created_by: user?._id || null,
        updated_by: user?._id || null,
    });
};

const updateConfig = async (id, configData, user) => {
    const cfg = await SkuMappingConfig.findByIdAndUpdate(
        id,
        { ...configData, updated_by: user?._id || null },
        { new: true }
    );
    if (!cfg) {
        const err = new Error("Config not found");
        err.status = 404;
        throw err;
    }
    return cfg;
};

const listConfigs = async (active, q) => {
    const filter = {};
    if (active === 'true') filter.is_active = true;
    if (q) filter.name = new RegExp(q, 'i');

    return await SkuMappingConfig.find(filter)
        .sort({ is_active: -1, priority: 1, updatedAt: -1 })
        .lean();
};

const toggleActive = async (id, isActive, user) => {
    const cfg = await SkuMappingConfig.findByIdAndUpdate(
        id,
        { is_active: !!isActive, updated_by: user?._id || null },
        { new: true }
    );
    if (!cfg) {
        const err = new Error("Config not found");
        err.status = 404;
        throw err;
    }
    return cfg;
};

const getActiveConfigs = async () => {
    const now = new Date();
    return await SkuMappingConfig.find({
        is_active: true,
        $and: [
            { $or: [{ valid_from: null }, { valid_from: { $lte: now } }] },
            { $or: [{ valid_to: null }, { valid_to: { $gte: now } }] },
        ],
    })
        .sort({ priority: 1, updatedAt: -1 })
        .lean();
};

module.exports = {
    createConfig,
    updateConfig,
    listConfigs,
    toggleActive,
    getActiveConfigs,
};

