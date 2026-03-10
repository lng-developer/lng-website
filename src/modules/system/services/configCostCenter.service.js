// src/modules/system/services/configCostCenter.service.js
const db = require('../../../models');
const ConfigCostCenter = db.configCostCenter;
const mongoose = require("mongoose");

const createConfig = async (payload, user) => {
    if (!payload.platform || !payload.config_code || !payload.country) {
        const error = new Error('platform, config_code, country are required');
        error.status = 400;
        throw error;
    }

    if (payload.product_for_seller && !mongoose.isValidObjectId(payload.product_for_seller)) {
        const error = new Error('product_for_seller is not a valid ObjectId');
        error.status = 400;
        throw error;
    }

    const doc = await ConfigCostCenter.create({
        ...payload,
        history: [{ action: 'create', by: user?._id, diff: payload }]
    });

    return await doc.populate('product_for_seller');
};

const listConfigs = async (query) => {
    const {
        page = 1,
        perPage = 10,
        platform,
        country,
        status,
        is_set,
        is_pack,
        code,
        product_for_seller,
        product_for_seller_name,
        search,
        sort = 'config_code:asc'
    } = query;

    const skip = (parseInt(page) - 1) * parseInt(perPage);
    const limit = parseInt(perPage);

    const useAggForName = product_for_seller_name && product_for_seller_name.trim() !== '';

    if (useAggForName) {
        const match = { is_deleted: false };
        if (platform) match.platform = platform;
        if (country) match.country = country;
        if (status) match.status = status;
        if (typeof is_set !== 'undefined') match.is_set = is_set === 'true';
        if (typeof is_pack !== 'undefined') match.is_pack = is_pack === 'true';
        if (search) match.config_code = search;
        if (product_for_seller && mongoose.isValidObjectId(product_for_seller)) {
            match.product_for_seller = new mongoose.Types.ObjectId(product_for_seller);
        }

        const pipeline = [
            { $match: match },
            {
                $lookup: {
                    from: 'producttypes',
                    localField: 'product_for_seller',
                    foreignField: '_id',
                    as: 'product_for_seller'
                }
            },
            { $unwind: { path: '$product_for_seller', preserveNullAndEmptyArrays: true } },
            { $match: { 'product_for_seller.name': { $regex: product_for_seller_name, $options: 'i' } } },
            { $sort: buildSort(sort) },
            {
                $facet: {
                    items: [{ $skip: skip }, { $limit: limit }],
                    total: [{ $count: 'count' }]
                }
            }
        ];

        const [agg] = await ConfigCostCenter
            .aggregate(pipeline)
            .collation({ locale: 'en', strength: 1, alternate: 'shifted', numericOrdering: true });

        const total = agg.total[0]?.count || 0;
        return { page: Number(page), perPage: Number(perPage), total, items: agg.items };
    }

    const filter = { is_deleted: false };
    if (platform) filter.platform = platform;
    if (country) filter.country = country;
    if (status) filter.status = status;
    if (typeof is_set !== 'undefined') filter.is_set = is_set === 'true';
    if (typeof is_pack !== 'undefined') filter.is_pack = is_pack === 'true';
    if (code) filter.config_code = code;
    if (product_for_seller && mongoose.isValidObjectId(product_for_seller)) {
        filter.product_for_seller = product_for_seller;
    }
    if (search) filter.$text = { $search: search };

    const [total, items] = await Promise.all([
        ConfigCostCenter.countDocuments(filter),
        ConfigCostCenter.find(filter)
            .sort(buildSort(sort))
            .collation({ locale: 'en', strength: 1, alternate: 'shifted', numericOrdering: true })
            .skip(skip)
            .limit(limit)
            .populate('product_for_seller')
            .lean()
    ]);

    return { page: Number(page), perPage: Number(perPage), total, items };
};

const getConfig = async (id) => {
    const item = await ConfigCostCenter.findOne({ _id: id, is_deleted: false })
        .populate('product_for_seller');
    if (!item) {
        const error = new Error('Not found');
        error.status = 404;
        throw error;
    }
    return item;
};

const updateConfig = async (id, payload, user) => {
    const before = await ConfigCostCenter.findOne({ _id: id, is_deleted: false });
    if (!before) {
        const error = new Error('Not found');
        error.status = 404;
        throw error;
    }
    if (payload.product_for_seller && !mongoose.isValidObjectId(payload.product_for_seller)) {
        const error = new Error('product_for_seller is not a valid ObjectId');
        error.status = 400;
        throw error;
    }

    return await ConfigCostCenter.findByIdAndUpdate(
        id,
        { $set: payload, $push: { history: { action: 'update', by: user?._id, diff: payload } } },
        { new: true }
    ).populate('product_for_seller');
};

const toggleStatus = async (id, status, user) => {
    if (!['Active', 'Inactive'].includes(status)) {
        const error = new Error('status must be Active or Inactive');
        error.status = 400;
        throw error;
    }
    const item = await ConfigCostCenter.findOneAndUpdate(
        { _id: id, is_deleted: false },
        { $set: { status }, $push: { history: { action: 'toggle', by: user?._id, diff: { status } } } },
        { new: true }
    ).populate('product_for_seller');

    if (!item) {
        const error = new Error('Not found');
        error.status = 404;
        throw error;
    }
    return item;
};

const toggleFlags = async (id, payload, user) => {
    const patch = {};
    if (typeof payload.is_set !== 'undefined') patch.is_set = !!payload.is_set;
    if (typeof payload.is_pack !== 'undefined') patch.is_pack = !!payload.is_pack;
    if (!Object.keys(patch).length) {
        const error = new Error('No flag provided');
        error.status = 400;
        throw error;
    }
    const item = await ConfigCostCenter.findOneAndUpdate(
        { _id: id, is_deleted: false },
        { $set: patch, $push: { history: { action: 'toggle', by: user?._id, diff: patch } } },
        { new: true }
    ).populate('product_for_seller');

    if (!item) {
        const error = new Error('Not found');
        error.status = 404;
        throw error;
    }
    return item;
};

const removeConfig = async (id, user) => {
    const item = await ConfigCostCenter.findOneAndUpdate(
        { _id: id, is_deleted: false },
        { $set: { is_deleted: true }, $push: { history: { action: 'delete', by: user?._id } } },
        { new: true }
    );
    if (!item) {
        const error = new Error('Not found');
        error.status = 404;
        throw error;
    }
    return item._id;
};

function buildSort(sort) {
    if (!sort) return { created_at: -1 };
    if (typeof sort === 'object') return sort;

    const obj = {};
    String(sort).split(',').forEach(t => {
        const token = t.trim();
        if (!token) return;
        if (token.includes(':')) {
            const [k, dir] = token.split(':').map(s => s.trim());
            obj[k === 'config_code' ? 'code_sort' : k] =
                (String(dir).toLowerCase() === 'desc' || dir === '-1') ? -1 : 1;
        } else {
            const k = token.startsWith('-') ? token.slice(1) : token;
            obj[k === 'config_code' ? 'code_sort' : k] = token.startsWith('-') ? -1 : 1;
        }
    });
    return Object.keys(obj).length ? obj : { code_sort: 1, created_at: 1 };
}

module.exports = {
    createConfig,
    listConfigs,
    getConfig,
    updateConfig,
    toggleStatus,
    toggleFlags,
    removeConfig
};

