// controllers/qc.controller.js
const mongoose = require('mongoose');
const db = require('../models');
const OrderCustomProduct = db.orderCustomProduct;
const VendorProduct = db.vendorProduct; // đảm bảo đã export trong models/index.js

const getQCList = async (req, res) => {
    try {
        const {
            page = 1,
            perPage = 10,
            from,
            to,
            statuses,          // filter theo Order.status
            search,            // regex theo orderId (+ mở rộng sku/orderItemId/email/name)
            shopName           // ✅ fix: trước đây biến này chưa được lấy từ query
        } = req.query;

        // === Điều kiện bắt buộc: chỉ đơn cần QC ===
        const matchStage = {
            scale_overall_status: 'Pending'
        };

        // --- filter theo status (Order.status) ---
        if (statuses && statuses.trim() !== '') {
            const statusArray = statuses.split(',').map(s => s.trim()).filter(Boolean);
            if (statusArray.length > 0) matchStage.status = { $in: statusArray };
        }

        // --- filter theo createdAt trong khoảng thời gian ---
        if (from && to) {
            matchStage.createdAt = {
                $gte: new Date(from),
                $lte: new Date(to)
            };
        }

        // --- filter theo search ---
        // mở rộng: orderId, items.sku, items.orderItemId, customer email/name
        let searchOr = null;
        if (search && search.trim() !== '') {
            const keyword = new RegExp(search.trim(), 'i');
            searchOr = [
                { orderId: keyword },
                { 'items.sku': keyword },
                { 'items.orderItemId': keyword },
                { 'customer_infor.email': keyword },
                { 'customer_infor.name': keyword }
            ];
        }

        const pipeline = [
            // 1) Bắt đầu từ Order
            { $match: matchStage },

            // 2) Join Shop
            {
                $lookup: {
                    from: 'shops',
                    localField: 'shopId',
                    foreignField: '_id',
                    as: 'shop'
                }
            },
            { $unwind: { path: '$shop', preserveNullAndEmptyArrays: true } },

            // 3) Filter theo shopName nếu có
            ...(shopName && shopName.trim() !== ''
                ? [{ $match: { 'shop.name': { $regex: new RegExp(shopName.trim(), 'i') } } }]
                : []),

            // 4) Join Case (nhiều)
            {
                $lookup: {
                    from: 'cases',
                    localField: 'case',
                    foreignField: '_id',
                    as: 'case'
                }
            },

            // 5) Áp dụng search nếu có
            ...(searchOr ? [{ $match: { $or: searchOr } }] : []),

            // 6) Chỉ giữ lại các items có scale_status = "Pending" để QC
            {
                $addFields: {
                    items: {
                        $filter: {
                            input: '$items',
                            as: 'it',
                            cond: { $eq: ['$$it.scale_status', 'Pending'] }
                        }
                    }
                }
            },

            // 7) Đảm bảo đơn còn ít nhất 1 item Pending sau khi filter
            { $match: { $expr: { $gt: [{ $size: '$items' }, 0] } } }
        ];

        // --- Count ---
        const countPipeline = [...pipeline, { $count: 'total' }];
        const countResult = await OrderCustomProduct.aggregate(countPipeline);
        const totalCount = countResult[0]?.total || 0;

        // --- Paginate ---
        const isAll = String(perPage).toLowerCase() === 'all';
        const skip = (parseInt(page) - 1) * parseInt(perPage);
        const limit = parseInt(perPage);

        pipeline.push({ $sort: { createdAt: -1 } });
        if (!isAll) pipeline.push({ $skip: skip }, { $limit: limit });

        // --- Query ---
        const orders = await OrderCustomProduct.aggregate(pipeline);

        // === Thu thập tất cả vendorProductId từ cost_breakdown của items ===
        const vendorIdSet = new Set();
        for (const o of orders) {
            for (const it of (o.items || [])) {
                const vId = it?.cost_breakdown?.vendorProductId;
                if (vId) vendorIdSet.add(String(vId));
            }
        }

        // === Lấy map: vendorProductId -> "Vendor Name - Product Name" ===
        let vendorFullNameMap = new Map();
        if (vendorIdSet.size > 0) {
            const idObjs = [];
            for (const id of vendorIdSet) {
                if (mongoose.Types.ObjectId.isValid(id)) {
                    idObjs.push(new mongoose.Types.ObjectId(id));
                }
            }

            if (idObjs.length > 0) {
                const vps = await VendorProduct.find({ _id: { $in: idObjs } })
                    .select('product_name vendor_id')
                    .populate({ path: 'vendor_id', select: 'name' })
                    .lean();

                vendorFullNameMap = new Map(
                    (vps || []).map(vp => {
                        const vendorName = vp?.vendor_id?.name || '';
                        const productName = vp?.product_name || '';
                        return [String(vp._id), `${vendorName} - ${productName}`.trim()];
                    })
                );
            }
        }

        // --- Shape output ---
        const result = orders.map(order => {
            const items = (order.items || []).map(item => {
                const surfaces = item.version3Data?.customizationInfo?.surfaces || [];
                const version3Data = surfaces.flatMap(surface =>
                    (surface.areas || []).map(area => ({
                        label: area.label || area.name || '',
                        value: area.optionValue || area.text || ''
                    }))
                );

                const vendorProductId = item?.cost_breakdown?.vendorProductId || null;
                const vendorProductDisplayName = vendorProductId
                    ? (vendorFullNameMap.get(String(vendorProductId)) || null)
                    : null;

                return {
                    orderItemId: item.orderItemId || null,
                    sku: item.sku,
                    title: item.title || '',
                    quantity: item.quantity || 1,
                    version3Data,
                    baseImageUrl: item.baseImage?.imageUrl || null,
                    snapshotImage: item.snapshotImage,
                    totalCustomizationPrice: item.totalCustomizationPrice || 0,
                    asin: item.asin,
                    customized_url: item.customized_url,
                    cost_center: {
                        vendorProductId,
                        vendorProductDisplayName,
                        sizeValue: item?.cost_breakdown?.sizeValue || null,
                        colorValue: item?.cost_breakdown?.colorValue || null
                    },
                    tracking_info: {
                        fulfillment: item?.tracking_info?.fulfillment,
                        status: item?.tracking_info?.status,
                        tracking: item?.tracking_info?.tracking,
                        note: item?.tracking_info?.note
                    },
                    fulfillment_file: item.fulfillment_file,
                    scale_status: item.scale_status // luôn là "Pending" sau filter
                };
            });

            return {
                orderId: order.orderId,
                merchantId: order.merchantId || null,
                marketplaceId: order.marketplaceId || null,
                customer_infor: order.customer_infor,
                status: order.status || '',
                customized_url: order.customized_url,
                purchase_date: order.purchase_date,
                createdAt: order.createdAt,
                shopName: order.shop?.name || null,
                shipping_type: order.shipping_type || null,
                items,
                base_cost: order.base_cost,
                case: order.case,
                address_validation: order.address_validation?.isValid,
                scale_overall_status: order.scale_overall_status // luôn là "Pending" theo matchStage
            };
        });

        res.json({
            data: result,
            totalCount,
            totalPages: isAll ? 1 : Math.ceil(totalCount / limit),
            currentPage: parseInt(page)
        });

    } catch (error) {
        console.error('❌ getQCList error:', error);
        res.status(500).json({
            message: 'Failed to retrieve QC list',
            error: error.message
        });
    }
};

module.exports = { getQCList };
