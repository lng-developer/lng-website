// src/modules/system/services/auditLog.service.js
const db = require('../../../models');
const OrderHistory = db.OrderHistory;

const listOrderHistory = async (query) => {
    const {
        page = 1,
        perPage = 20,
        orderId,
        action,
        userId,
        source,
        startDate,
        endDate,
        sort = '-createdAt'
    } = query;

    const skip = (parseInt(page) - 1) * parseInt(perPage);
    const limit = parseInt(perPage);

    const filter = {};
    if (orderId) filter.orderId = orderId;
    if (action) filter.action = action;
    if (userId) filter.userId = userId;
    if (source) filter.source = source;

    if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = new Date(startDate);
        if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const sortDir = sort.startsWith('-') ? -1 : 1;
    const sortField = sort.startsWith('-') ? sort.substring(1) : sort;

    const [total, items] = await Promise.all([
        OrderHistory.countDocuments(filter),
        OrderHistory.find(filter)
            .sort({ [sortField]: sortDir })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email')
            .populate('order', 'orderId status')
            .lean()
    ]);

    return {
        total,
        page: Number(page),
        perPage: Number(perPage),
        totalPages: Math.ceil(total / limit),
        items
    };
};

const getOrderHistoryById = async (id) => {
    const item = await OrderHistory.findById(id)
        .populate('userId', 'name email')
        .populate('order')
        .lean();

    if (!item) {
        const error = new Error('Log entry not found');
        error.status = 404;
        throw error;
    }
    return item;
};

module.exports = {
    listOrderHistory,
    getOrderHistoryById
};

