const db = require('../models');
const OrderCustomProduct = db.orderCustomProduct;
const multer = require('multer');
const fs = require('fs');
const XLSX = require('xlsx');
const path = require('path');
const upload = multer({ dest: 'uploads/' });
const axios = require('axios');
const AdmZip = require('adm-zip');
const streamifier = require('streamifier');
const cloudinary = require('../utils/cloudinary');
const Shop = db.shop;
const ConfigCostCenter = db.configCostCenter;
const VendorCostCenter = db.vendorCostCenter;
const VendorProduct = db.vendorProduct;


const mongoose = require('mongoose');

require('dotenv').config();

const importOrderJson = async (req, res) => {
    try {
        const jsonData = req.body;
        const order = await OrderCustomProduct.findOne({ orderId: jsonData.orderId });
        if (!order) return res.status(404).json({ message: 'Order ID not found' });

        const item = order.items.find(i => i.orderItemId === jsonData.orderItemId);
        if (!item) return res.status(404).json({ message: 'OrderItem ID not found in Order' });

        // ❌ Nếu item đã có customization hoặc snapshotImage → bỏ qua hoàn toàn
        if (item.customization || item.snapshotImage) {
            return res.status(409).json({ message: 'Item already has customization data. Skipped.' });
        }

        // ✅ Tính tổng phí tùy chọn
        let totalCustomizationPrice = 0;
        const options = jsonData?.customizationData?.children?.[0]?.children?.[0]?.children || [];

        options.forEach(opt => {
            const amount = opt?.optionSelection?.additionalCost?.amount || 0;
            totalCustomizationPrice += Number(amount);
        });

        // ✅ Map các tùy chọn tuỳ chỉnh
        const customizationOptions = {};
        options.forEach(opt => {
            const label = opt?.label;
            const optionSelection = opt?.optionSelection;

            switch (label) {
                case "Custom Name":
                    customizationOptions.customName = opt?.inputValue || "";
                    break;
                case "Text Color":
                    customizationOptions.textColor = optionSelection?.name || "";
                    break;
                case "Photo Options":
                    customizationOptions.photoOptions = optionSelection?.name || "";
                    break;
                case "Photo Quality Enhancement":
                    customizationOptions.photoQualityEnhancement = optionSelection || null;
                    break;
                case "Select Size":
                    customizationOptions.sizeOption = optionSelection || null;
                    break;
                case "Select Pack":
                    customizationOptions.packOption = optionSelection || null;
                    break;
                case "Priority Production":
                    customizationOptions.priorityProduction = optionSelection || null;
                    break;
                default:
                    if (label?.startsWith("We would be grateful")) {
                        customizationOptions.thankYouMessage = optionSelection || null;
                    }
                    break;
            }
        });

        // ✅ Ảnh khách upload
        const imageCustomization = options.find(opt => opt?.type === "PlacementContainerCustomization");
        const imageData = imageCustomization?.children?.[0]?.image || {};

        customizationOptions.photoUploaded = {
            imageName: imageData?.imageName || "",
            buyerFilename: imageData?.buyerFilename || ""
        };

        // ✅ Gán thông tin cho item
        item.asin = jsonData.asin;
        item.customization = customizationOptions;
        item.customizationData = jsonData.customizationData || null;
        item.version3Data = jsonData["version3.0"] || null;
        item.baseImage = {
            imageUrl: jsonData?.customizationData?.children?.[0]?.baseImage?.imageUrl || "",
            width: jsonData?.customizationData?.children?.[0]?.baseImage?.dimension?.width || null,
            height: jsonData?.customizationData?.children?.[0]?.baseImage?.dimension?.height || null
        };

        item.snapshotImage = (jsonData?.cloudinarySnapshots && jsonData.cloudinarySnapshots[0]) || "";
        item.svgFile = jsonData?.customizationData?.children?.[0]?.svg || "";
        item.totalCustomizationPrice = totalCustomizationPrice;

        await order.save();
        res.status(200).json({ message: 'Order updated successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update order', error: error.message });
    }
};

const importOrderFromFile = async (req, res) => {
    try {
        const filePath = req.file.path;
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const jsonData = JSON.parse(fileContent);

        req.body = jsonData;
        await importOrderJson(req, res);

        fs.unlinkSync(filePath);

    } catch (error) {
        res.status(500).json({ message: 'Failed to process JSON file', error: error.message });
    }
};

const validateAddressWithSmarty = async (address) => {
    try {
        const response = await axios.get('https://us-street.api.smarty.com/street-address', {
            params: {
                'auth-id': process.env.SMARTY_AUTH_ID,
                'auth-token': process.env.SMARTY_AUTH_TOKEN,
                street: address.address,
                street2: address.address_2,
                city: address.city,
                state: address.state,
                zipcode: address.zip_code
            }
        });
        const data = response.data;
        if (Array.isArray(data) && data.length > 0) {
            return { isValid: true, smartyResponse: data[0] };
        }

        return { isValid: false, smartyResponse: null };
    } catch (err) {
        return { isValid: false, smartyResponse: { error: err.message } };
    }
};

const updateOrdersFromXlsx = async (req, res) => {
    try {
        const filePath = req.file.path;
        const ext = path.extname(req.file.originalname).toLowerCase();
        let rows = [];
        const shopId = req.body.shopId;
        const type = req.body.type;

        if (ext === '.txt') {
            const raw = fs.readFileSync(filePath, 'utf8');
            const delimiter = raw.includes('\t') ? '\t' : ',';
            const lines = raw.split('\n').filter(line => line.trim() !== '');
            const headers = lines[0].trim().split(delimiter).map(h => h.trim().replace(/-/g, '_'));
            rows = lines.slice(1).map(line => {
                const values = line.trim().split(delimiter);
                const obj = {};
                headers.forEach((key, index) => {
                    obj[key] = values[index]?.trim() || '';
                });
                return obj;
            });
        } else {
            return res.status(400).json({ message: 'Only .txt files are supported' });
        }

        const results = [];

        if (type === 'Latest ship date') {
            for (const row of rows) {
                const orderId = row.amazon_order_id;
                const newStatus = row.order_status?.trim();
                if (!orderId || !newStatus) continue;

                let existingOrder = await OrderCustomProduct.findOne({ orderId });

                if (existingOrder) {
                    if (newStatus === 'Pending') {
                        results.push({ orderId, status: 'skipped - pending' });
                        continue;
                    }

                    if (existingOrder.status !== newStatus) {
                        const oldStatus = existingOrder.status;
                        existingOrder.status = newStatus;
                        await existingOrder.save();
                        results.push({ orderId, status: 'status updated', from: oldStatus, to: newStatus });
                    } else {
                        results.push({ orderId, status: 'skipped - same status' });
                    }
                    // ✅ Kiểm tra địa chỉ nếu chưa có
                    if (
                        existingOrder.address_validation?.isValid === null &&
                        existingOrder.address_validation?.smartyResponse === null
                    ) {
                        const validationResult = await validateAddressWithSmarty(existingOrder.customer_infor);
                        existingOrder.address_validation = validationResult;
                        await existingOrder.save();

                        results.push({
                            orderId,
                            addressChecked: true,
                            addressValid: validationResult.isValid
                        });
                    }


                    continue;
                }
            }

            return res.json({ message: 'Update by latest ship date completed', results });
        }

        // ✅ Flow mặc định
        for (const row of rows) {
            const orderId = row.order_id;
            if (!orderId) continue;

            const itemData = {
                orderItemId: row.order_item_id,
                sku: row.sku,
                title: row.product_name,
                customized_url: row.customized_url,
                quantity: Number(row.quantity_purchased || 1)
            };

            const basicData = {
                orderId,
                shopId,
                purchase_date: row.purchase_date,
                customer_infor: {
                    email: row.buyer_email,
                    name: row.recipient_name,
                    phone_number: row.ship_phone_number,
                    address: row.ship_address_1,
                    address_2: row.ship_address_2,
                    province: row.province,
                    city: row.ship_city,
                    state: row.ship_state,
                    zip_code: row.ship_postal_code,
                    country: row.ship_country
                },
                shipping_type: row.ship_service_level,
                base_cost: 0
            };

            const existing = await OrderCustomProduct.findOne({ orderId });
            let skipProcessingZip = false;

            if (existing) {
                const exists = existing.items.some(i => i.orderItemId === itemData.orderItemId);
                if (!exists) {
                    existing.items.push(itemData);
                    await existing.save();
                    results.push({ orderId, status: 'item added' });
                } else {
                    results.push({ orderId, status: 'item exists' });
                    skipProcessingZip = true;
                }
            } else {
                const newOrder = new OrderCustomProduct({ ...basicData, items: [itemData] });
                await newOrder.save();

                const validationResult = await validateAddressWithSmarty(basicData.customer_infor);
                newOrder.address_validation = validationResult;
                await newOrder.save();

                results.push({
                    orderId,
                    status: 'New order created with address check',
                    addressValid: validationResult.isValid
                });
            }

            if (skipProcessingZip) continue;

            try {
                const url = row.customized_url;
                if (!url) {
                    results.push({ orderId, status: 'no URL' });
                    continue;
                }

                const zipResponse = await axios.get(url, { responseType: 'arraybuffer' });
                const zip = new AdmZip(Buffer.from(zipResponse.data));

                const imageEntries = zip.getEntries().filter(entry => /\.(jpe?g|png)$/i.test(entry.entryName));
                const cloudinaryUrls = [];

                for (const imageEntry of imageEntries) {
                    const imageBuffer = imageEntry.getData();
                    const imageName = path.basename(imageEntry.entryName);
                    const cloudinaryUrl = await uploadToCloudinary(imageBuffer, imageName);
                    cloudinaryUrls.push(cloudinaryUrl);
                }

                const jsonEntry = zip.getEntries().find(entry => entry.entryName.endsWith('.json'));
                if (!jsonEntry) {
                    results.push({ orderId, status: 'no JSON in ZIP', snapshots: cloudinaryUrls });
                    continue;
                }

                const jsonData = JSON.parse(zip.readAsText(jsonEntry));
                jsonData.cloudinarySnapshots = cloudinaryUrls;

                const fakeReq = { body: jsonData };
                const fakeRes = {
                    status: code => ({
                        json: msg => results.push({
                            orderId,
                            status: code,
                            message: msg?.message || msg,
                            snapshots: cloudinaryUrls
                        })
                    })
                };

                await importOrderJson(fakeReq, fakeRes);
            } catch (err) {
                results.push({ orderId, status: 'failed', error: err.message });
            }
        }

        fs.unlinkSync(filePath);
        res.json({ message: 'Batch import completed', results });
    } catch (error) {
        res.status(500).json({ message: 'Batch import failed', error: error.message });
    }
};

const uploadToCloudinary = (buffer, filename) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                resource_type: 'image',
                folder: 'snapshot_images',
                public_id: path.parse(filename).name
            },
            (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
            }
        );
        streamifier.createReadStream(buffer).pipe(stream);
    });
};

const getAllOrders = async (req, res) => {
    try {
        const orders = await OrderCustomProduct.find().sort({ createdAt: -1 });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ message: 'Failed to retrieve orders', error: error.message });
    }
};

const getOrderById = async (req, res) => {
    try {
        const order = await OrderCustomProduct.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        res.json(order);
    } catch (error) {
        res.status(500).json({ message: 'Failed to retrieve order', error: error.message });
    }
};

// ✅ Updated getFrontendOrders to group multiple items under one orderId
const getFrontendOrders = async (req, res) => {
    try {
        const {
            page = 1,
            perPage = 10,
            from,
            to,
            statuses,
            isNoCostCenter,
            financialStatus,
            sevenDayAlert,
            platform,
            search,
            userNull,
            noPsd,
            shippingType,
            shopName,
            openCase
        } = req.query;

        const matchStage = {};

        if (statuses && statuses.trim() !== '') {
            const statusArray = statuses.split(',').filter(s => s.trim());
            if (statusArray.length > 0) matchStage.status = { $in: statusArray };
        }

        if (search) {
            const keyword = new RegExp(search, 'i');
            matchStage.$or = [
                { orderId: keyword },
                { 'customer_infor.name': keyword }
            ];
        }
        if (openCase === 'true') {
            matchStage.case = { $exists: true, $not: { $size: 0 } };
        }
        if (from && to) {
            matchStage.createdAt = {
                $gte: new Date(from),
                $lte: new Date(to)
            };
        }

        if (isNoCostCenter === 'true') {
            matchStage.base_cost = { $in: [null, 0] };
        }

        if (financialStatus) {
            matchStage.financialStatus = financialStatus;
        }

        if (sevenDayAlert === 'true') {
            const today = new Date();
            const sevenDaysLater = new Date(today);
            sevenDaysLater.setDate(today.getDate() + 7);
            matchStage.deliveryDate = { $lte: sevenDaysLater };
        }

        if (platform) {
            matchStage.platform = platform;
        }

        if (userNull === 'true') {
            matchStage.userId = null;
        }

        if (noPsd === 'true') {
            matchStage['items.snapshotImage'] = { $in: [null, ''] };
        }

        if (shippingType && shippingType.trim() !== '') {
            const validShippingTypes = ["Second Day", "Ground", "Overnight", "Economy", "Standard", "Expedited"];
            const types = shippingType.split(',').map(t => t.trim()).filter(t => validShippingTypes.includes(t));
            if (types.length === 1) {
                matchStage.shipping_type = types[0];
            } else if (types.length > 1) {
                matchStage.shipping_type = { $in: types };
            }
        }

        const pipeline = [
            {
                $lookup: {
                    from: 'shops',
                    localField: 'shopId',
                    foreignField: '_id',
                    as: 'shop'
                }
            },
            { $unwind: '$shop' },

            ...(shopName && shopName.trim() !== ''
                ? [{ $match: { 'shop.name': { $regex: new RegExp(shopName.trim(), 'i') } } }]
                : []),

            {
                $lookup: {
                    from: 'cases',
                    localField: 'case',
                    foreignField: '_id',
                    as: 'case'
                }
            },

            { $match: matchStage }
        ];

        const countPipeline = [...pipeline, { $count: 'total' }];
        const countResult = await OrderCustomProduct.aggregate(countPipeline);
        const totalCount = countResult[0]?.total || 0;

        const isAll = perPage === 'All';
        const skip = (parseInt(page) - 1) * parseInt(perPage);
        const limit = parseInt(perPage);

        pipeline.push({ $sort: { createdAt: -1 } });
        if (!isAll) {
            pipeline.push({ $skip: skip }, { $limit: limit });
        }

        const orders = await OrderCustomProduct.aggregate(pipeline);

        // === Thu thập tất cả vendorProductId từ cost_breakdown của items ===
        const vendorIdSet = new Set();
        for (const o of orders) {
            for (const it of (o.items || [])) {
                const vId = it?.cost_breakdown?.vendorProductId;
                if (vId) vendorIdSet.add(String(vId));
            }
        }

        // === Lấy map: vendorProductId -> "Vendor Name + Product Name" ===
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
                        const full = `${vendorName} - ${productName}`.trim();
                        return [String(vp._id), full];
                    })
                );
            }
        }

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

                    // ⬇️ Trả thêm
                    vendorProductId,
                    vendorProductDisplayName,      // "Vendor Name + Product Name"
                    sizeValue: item?.cost_breakdown?.sizeValue || null,
                    colorValue: item?.cost_breakdown?.colorValue || null
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
                address_validation: order.address_validation?.isValid
            };
        });

        res.json({
            data: result,
            totalCount,
            totalPages: isAll ? 1 : Math.ceil(totalCount / limit),
            currentPage: parseInt(page)
        });

    } catch (error) {
        console.error('❌ getFrontendOrders error:', error);
        res.status(500).json({
            message: 'Failed to retrieve frontend orders',
            error: error.message
        });
    }
};



const getOrderStatistics = async (req, res) => {
    try {
        const {
            from,
            to,
            search,
            platform,
            userNull,
            noPsd,
            shippingType,
            shopId,
            openCase
        } = req.query;

        const baseFilter = {};

        if (from && to) {
            if (isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
                return res.status(400).json({ message: 'Invalid date format in from or to' });
            }
            baseFilter.createdAt = {
                $gte: new Date(from),
                $lte: new Date(to)
            };
        }

        if (search) {
            const keyword = new RegExp(search, 'i');
            baseFilter.$or = [
                { orderId: keyword },
                { 'customer_infor.name': keyword }
            ];
        }

        if (platform) {
            baseFilter.platform = platform;
        }

        if (userNull === 'true') {
            baseFilter.userId = null;
        }

        if (noPsd === 'true') {
            baseFilter['items.snapshotImage'] = { $in: [null, ''] };
        }

        if (openCase === 'true') {
            baseFilter.case = { $exists: true, $not: { $size: 0 } };
        }

        if (shippingType && shippingType.trim() !== '') {
            const validShippingTypes = ["Second Day", "Ground", "Overnight", "Economy", "Standard", "Expedited"];
            const types = shippingType.split(',').map(t => t.trim()).filter(t => validShippingTypes.includes(t));
            if (types.length === 1) {
                baseFilter.shipping_type = types[0];
            } else if (types.length > 1) {
                baseFilter.shipping_type = { $in: types };
            }
        }

        if (shopId) {
            baseFilter.shopId = new mongoose.Types.ObjectId(shopId);
        }

        const [
            all,
            newCount,
            noCostCenter,
            paymentPending,
            fulfillment,
            shipped,
            cancelled,
            refund,
            openCaseCount
        ] = await Promise.all([
            OrderCustomProduct.countDocuments(baseFilter),
            OrderCustomProduct.countDocuments({ ...baseFilter, status: 'New' }),
            OrderCustomProduct.countDocuments({ ...baseFilter, base_cost: { $in: [null, 0] } }),
            OrderCustomProduct.countDocuments({ ...baseFilter, financialStatus: 'Pending' }),
            OrderCustomProduct.countDocuments({ ...baseFilter, status: 'Fulfilled' }),
            OrderCustomProduct.countDocuments({ ...baseFilter, status: 'Shipped' }),
            OrderCustomProduct.countDocuments({ ...baseFilter, status: 'Cancelled' }),
            OrderCustomProduct.countDocuments({ ...baseFilter, status: 'Refund' }),
            OrderCustomProduct.countDocuments({ ...baseFilter, case: { $exists: true, $not: { $size: 0 } } })
        ]);

        res.json({
            all,
            new: newCount,
            noCostCenter,
            paymentPending,
            fulfilled: fulfillment,
            shipped,
            cancelled,
            refund,
            openCase: openCaseCount
        });

    } catch (error) {
        res.status(500).json({
            message: 'Failed to retrieve order statistics',
            error: error.message
        });
    }
};

const updateOrderStatus = async (req, res) => {
    try {
        const { orderId, status } = req.body;
        const allowedStatuses = ['New', 'Fulfilled', 'Shipped', 'Cancelled'];

        if (!orderId || !status) {
            return res.status(400).json({ message: 'Missing orderId or status' });
        }

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid status value' });
        }

        const order = await OrderCustomProduct.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        order.status = status;
        await order.save();

        res.status(200).json({ message: 'Order status updated successfully', orderId, newStatus: status });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update order status', error: error.message });
    }
};

const updateShippingType = async (req, res) => {
    try {
        const { orderId, shipping_type } = req.body;
        const allowedShippingType = ["Second Day", "Ground", "Overnight", "Economy", "Standard"];

        if (!orderId || !shipping_type) {
            return res.status(400).json({ message: 'Missing orderId or shipping type' });
        }

        if (!allowedShippingType.includes(shipping_type)) {
            return res.status(400).json({ message: 'Invalid status value' });
        }

        const order = await OrderCustomProduct.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        order.shipping_type = shipping_type;
        await order.save();

        res.status(200).json({ message: 'Order shipping type updated successfully', orderId, newShippingType: shipping_type });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update order shipping type', error: error.message });
    }
};

const updateBaseCost = async (req, res) => {
    try {
        const { orderId, base_cost } = req.body;

        if (!orderId || base_cost === undefined || base_cost === null) {
            return res.status(400).json({ message: 'Missing orderId or base cost' });
        }

        if (typeof base_cost !== 'number' || base_cost <= 0) {
            return res.status(400).json({ message: 'Base Cost must be a positive number' });
        }

        const order = await OrderCustomProduct.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        order.base_cost = base_cost;
        await order.save();

        res.status(200).json({ message: 'Order base cost updated successfully', orderId, newBaseCost: base_cost });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update order base cost', error: error.message });
    }
};

const updateCustomerInfo = async (req, res) => {
    try {
        const { orderId, customer_infor } = req.body;

        if (!orderId || !customer_infor || typeof customer_infor !== 'object') {
            return res.status(400).json({ message: 'Missing or invalid orderId or customer_infor' });
        }

        const order = await OrderCustomProduct.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        // Nếu chưa có field customer_infor, khởi tạo object
        if (!order.customer_infor) order.customer_infor = {};

        // Chỉ cập nhật các trường được truyền lên
        Object.keys(customer_infor).forEach(key => {
            order.customer_infor[key] = customer_infor[key];
        });

        await order.save();

        res.status(200).json({ message: 'Customer info updated successfully', orderId });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update customer info', error: error.message });
    }
};

const openCaseInOrder = async (req, res) => {
    try {
        const { orderId, caseIds } = req.body;

        if (!orderId || !Array.isArray(caseIds)) {
            return res.status(400).json({ message: 'Missing orderId or caseIds (should be an array)' });
        }

        const order = await OrderCustomProduct.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        // Khởi tạo nếu chưa có
        if (!Array.isArray(order.case)) {
            order.case = [];
        }
        // Lọc bỏ các case đã có trong mảng
        const newCaseIds = caseIds.filter(id => !order.case.includes(id));
        // Append vào mảng
        order.case.push(...newCaseIds);

        await order.save();

        res.status(200).json({ message: 'Case field appended successfully', orderId, case: order.case });
    } catch (error) {
        res.status(500).json({ message: 'Failed to append case field', error: error.message });
    }
};

const removeCaseFromOrder = async (req, res) => {
    try {
        const { orderId, caseIds } = req.body;

        if (!orderId || !Array.isArray(caseIds)) {
            return res.status(400).json({ message: 'Missing orderId or caseIds (should be an array)' });
        }

        const order = await OrderCustomProduct.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        // Loại bỏ các case có trong caseIds
        order.case = order.case.filter(existingCaseId => !caseIds.includes(String(existingCaseId)));

        await order.save();

        res.status(200).json({ message: 'Case(s) removed successfully', orderId, case: order.case });
    } catch (error) {
        res.status(500).json({ message: 'Failed to remove case(s)', error: error.message });
    }
};

const updateBaseImageUrl = async (req, res) => {
    try {
        const { orderId, orderItemId, imageUrl } = req.body;

        // Validate input
        if (!orderId || !orderItemId || !imageUrl) {
            return res.status(400).json({ message: 'Missing orderId, orderItemId, or imageUrl' });
        }

        // Validate imageUrl format (basic URL validation)
        const urlRegex = /^(https?:\/\/[^\s$.?#].[^\s]*)$/;
        if (!urlRegex.test(imageUrl)) {
            return res.status(400).json({ message: 'Invalid imageUrl format' });
        }

        // Find the order
        const order = await OrderCustomProduct.findOne({ orderId });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        // Find the item within the order
        const item = order.items.find(i => i.orderItemId === orderItemId);
        if (!item) {
            return res.status(404).json({ message: 'OrderItem ID not found in Order' });
        }

        // Update baseImage.imageUrl
        if (!item.baseImage) {
            item.baseImage = {};
        }
        item.baseImage.imageUrl = imageUrl;

        // Save the updated order
        await order.save();

        res.status(200).json({
            message: 'Base image URL updated successfully',
            orderId,
            orderItemId,
            newImageUrl: imageUrl
        });
    } catch (error) {
        res.status(500).json({
            message: 'Failed to update base image URL',
            error: error.message
        });
    }
};

// ================== BASE COST HELPERS & APIS ==================
function parseConfigCodeFromSKU(sku = '') {
    // SKU dạng <manhanvien>-<configcode>-<date>-<stt>
    // ví dụ: J2504-NK-1507-18  => NK
    const parts = String(sku).split('-').map(s => s.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[1] : '';
}

function toArray(val) {
    if (Array.isArray(val)) return val;
    if (val == null) return [];
    return [val];
}

function normalize(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// Alias hỗ trợ match thực tế (an toàn, chỉ áp dụng khi đúng pattern)
function normalizeSizeAlias(val) {
    const s = String(val || '');
    const m = s.match(/\(([^)]+)\)/); // ví dụ: Beverage (4.8" x 4.8") -> 4.8" x 4.8"
    return m ? m[1] : s;
}
function normalizePackAlias(val) {
    const s = String(val || '').trim();
    // "Pack 30pcs" -> "30 pcs"
    const m = s.match(/pack\s*(\d+)\s*pcs?/i);
    if (m) return `${m[1]} pcs`;
    return s;
}

// Trích { label => value } từ item.version3Data (ưu tiên) hoặc item.customizationData
function extractLabelValueMapFromItem(item) {
    const map = new Map();

    // ƯU TIÊN: version3Data.customizationInfo.surfaces[].areas[]
    const surfacesV3 = item?.version3Data?.customizationInfo?.surfaces || [];
    for (const sf of surfacesV3) {
        for (const area of (sf?.areas || [])) {
            const label = area?.label || area?.name || '';
            const value = (area?.optionValue ?? area?.text ?? '');
            if (label) map.set(normalize(label), String(value));
        }
    }

    // FALLBACK: customizationData.children[0].children[0].children
    if (map.size === 0) {
        const opts = item?.customizationData?.children?.[0]?.children?.[0]?.children || [];
        for (const opt of opts) {
            const label = opt?.label || opt?.name || '';
            let value = '';
            if (opt?.optionSelection) value = opt.optionSelection?.label || opt.optionSelection?.name || '';
            else if (typeof opt?.inputValue === 'string') value = opt.inputValue;
            else if (opt?.displayValue) value = opt.displayValue;
            if (label) map.set(normalize(label), String(value || ''));
        }
    }
    return map;
}

function pickValueByKeys(labelValueMap, keys = []) {
    for (const k of toArray(keys)) {
        const v = labelValueMap.get(normalize(k));
        if (v != null && v !== '') return v;
    }
    return '';
}

// B3.1: chọn đúng ConfigCostCenter theo product type
async function selectConfigByProductType(configCode, labelValueMap) {
    // Lấy tất cả config trùng config_code
    const cfgCandidates = await ConfigCostCenter.find({
        config_code: configCode,
        is_deleted: { $in: [false, null] }
    }).populate('product_for_seller').lean();

    if (!cfgCandidates.length) return { cfg: null, reason: 'No config cost center found by config_code' };

    // Thử khớp exact theo customize_product_type_key -> product_for_seller.name
    for (const c of cfgCandidates) {
        const typeValRaw = pickValueByKeys(labelValueMap, c.customize_product_type_key || []);
        const typeVal = normalize(typeValRaw);
        const sellerName = normalize(c?.product_for_seller?.name || '');
        if (typeVal && sellerName && typeVal === sellerName) {
            return { cfg: c, productTypeValue: typeValRaw, matchedBy: 'product_type_exact' };
        }
    }

    // Nếu chỉ có 1 config thì dùng luôn (fallback an toàn)
    if (cfgCandidates.length === 1) {
        const only = cfgCandidates[0];
        const typeValRaw = pickValueByKeys(labelValueMap, only.customize_product_type_key || []);
        return { cfg: only, productTypeValue: typeValRaw, matchedBy: 'single_candidate_fallback' };
    }

    // Không xác định được
    return { cfg: null, reason: 'Multiple configs; cannot determine by product type key/value' };
}

// B3.2: Tìm best match theo vendor_size / vendor_color (strict)
function findBestCostCenter(candidates, sizeValue, colorValue, { strict = true } = {}) {
    const norm = s => String(s || '').toLowerCase().trim();
    const sizeN = norm(sizeValue);
    const colorN = norm(colorValue);

    // Khớp tuyệt đối cả size & color
    const hit = candidates.find(c => norm(c.vendor_size) === sizeN && norm(c.vendor_color) === colorN);
    if (hit) return hit;

    if (strict) return null; // KHÔNG fallback khi yêu cầu trùng khít
    return null;
}

/**
 * POST body: { orderId: string }
 * Flow:
 * B1: Parse SKU -> config_code
 * B2: Tìm Config Cost Center theo config_code
 * B3: Dùng customize_product_type_key để chọn đúng config (product_for_seller.name == value),
 *     sau đó lấy customize_size_key, customize_color_key và đọc giá trị từ version3Data
 * B3.2: Match với vendor_size/vendor_color
 * B4: Lấy base_cost + tính phí shipping quốc tế theo nhóm vendor_product
 * B5: LƯU breakdown vào model order & items
 */
const computeBaseCostForOrder = async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ message: 'Missing orderId' });

        const order = await OrderCustomProduct.findOne({ orderId }).lean(false);
        if (!order) return res.status(404).json({ message: 'Order not found' });
        if (!Array.isArray(order.items) || order.items.length === 0) {
            return res.status(400).json({ message: 'Order has no items' });
        }

        // Gom item theo nhóm vận chuyển (vendor_product)
        const groups = new Map(); // key: vendor_productId, val: { items: [...], economy, additional }
        const stagedItems = [];   // tạm giữ kết quả từng item trước khi phân bổ ship

        for (const item of order.items) {
            const sku = item?.sku || '';
            const configCode = parseConfigCodeFromSKU(sku);
            if (!configCode) {
                stagedItems.push({ orderItemId: item.orderItemId, sku, status: 'failed', reason: 'Cannot parse config code from SKU' });
                continue;
            }

            // Chuẩn bị map label->value từ order
            const labelValueMap = extractLabelValueMapFromItem(item);

            // B2 + B3.1: chọn đúng config theo product type
            const { cfg, productTypeValue, matchedBy, reason: cfgReason } = await selectConfigByProductType(configCode, labelValueMap);
            if (!cfg) {
                stagedItems.push({
                    orderItemId: item.orderItemId, sku, configCode,
                    status: 'failed',
                    reason: cfgReason || 'Config cost center not found by product type'
                });
                continue;
            }

            // B3: lấy Size/Color values theo key từ config đã chọn
            let sizeValue = pickValueByKeys(labelValueMap, cfg.customize_size_key || []);
            let colorValue = pickValueByKeys(labelValueMap, cfg.customize_color_key || []);

            // Alias để tăng tỉ lệ match thực tế
            sizeValue = normalizeSizeAlias(sizeValue);
            colorValue = normalizePackAlias(colorValue);

            // Lấy vendor_product từ product_for_seller.items của config đã chọn
            const pfItems = toArray(cfg?.product_for_seller?.items).filter(Boolean);
            if (!pfItems.length) {
                stagedItems.push({
                    orderItemId: item.orderItemId, sku, configCode, sizeValue, colorValue,
                    status: 'failed', reason: 'product_for_seller has no items'
                });
                continue;
            }
            const chosenItem = pfItems.find(it => (it.status || '').toLowerCase() === 'active') || pfItems[0];
            const vendorProductId = chosenItem?.vendor_product;
            if (!vendorProductId) {
                stagedItems.push({
                    orderItemId: item.orderItemId, sku, configCode, sizeValue, colorValue,
                    status: 'failed', reason: 'Missing vendor_product in product_for_seller item'
                });
                continue;
            }

            // B3.2: lấy các cost centers của vendor_product và match size/color
            const candidates = await VendorCostCenter.find({
                vendor_product: vendorProductId,
                status: { $in: ['Active', null] }
            })
                .select('vendor_size vendor_color standard_size standard_color base_cost sku international.economy international.additional')
                .lean();

            if (!candidates.length) {
                stagedItems.push({
                    orderItemId: item.orderItemId, sku, configCode, sizeValue, colorValue,
                    status: 'failed', reason: 'No vendor cost centers for this vendor_product'
                });
                continue;
            }

            const matched = findBestCostCenter(candidates, sizeValue, colorValue, { strict: true });
            const baseEach = Number(matched?.base_cost || 0);
            if (!matched || !baseEach) {
                stagedItems.push({
                    orderItemId: item.orderItemId, sku, configCode, sizeValue, colorValue,
                    status: 'failed', reason: 'No matching size/color or base_cost missing'
                });
                continue;
            }

            const qty = Math.max(1, Number(item.quantity || 1));
            const eco = Number(matched?.international?.economy || 0);
            const add = Number(matched?.international?.additional || 0);

            const rec = {
                orderItemId: item.orderItemId,
                sku,
                configCode,
                productTypeValue: productTypeValue || null,
                selectedConfigBy: matchedBy || 'unknown',
                sizeValue,
                colorValue,
                vendorProductId: String(vendorProductId),
                baseEach, qty, eco, add, matchedSku: matched.sku || null,
                status: 'ok'
            };
            stagedItems.push(rec);

            // Cập nhật nhóm ship theo vendor_product
            const g = groups.get(rec.vendorProductId) || { items: [], economy: 0, additional: 0 };
            g.items.push(rec);
            // nếu nhiều bản ghi có eco/add khác nhau, lấy MAX để an toàn
            g.economy = Math.max(g.economy, eco);
            g.additional = Math.max(g.additional, add);
            groups.set(rec.vendorProductId, g);
        }

        // Tính tổng: base (theo item) + phí ship phân bổ theo nhóm
        let orderTotalBaseCost = 0;
        const perItemResults = [];
        const groupBreakdowns = [];

        // 1) cộng phần base item (chưa ship)
        for (const rec of stagedItems) {
            if (rec.status !== 'ok') {
                perItemResults.push(rec);
                continue;
            }
            const basePart = rec.baseEach * rec.qty;
            orderTotalBaseCost += basePart;

            perItemResults.push({
                orderItemId: rec.orderItemId,
                sku: rec.sku,
                configCode: rec.configCode,
                productTypeValue: rec.productTypeValue,
                selectedConfigBy: rec.selectedConfigBy,
                sizeValue: rec.sizeValue,
                colorValue: rec.colorValue,
                vendorProductId: rec.vendorProductId, // <- để lưu vào item
                matchedSku: rec.matchedSku,
                base_cost_each: rec.baseEach,
                quantity: rec.qty,
                // tạm 0, lát update bởi phân bổ ship
                shipping_international_economy: 0,
                shipping_international_additional_units: 0,
                shipping_international_additional_rate: 0,
                base_cost_total_for_item_including_shipping: basePart,
                status: 'ok'
            });
        }

        // 2) phân bổ phí ship theo nhóm vendor_product
        for (const [groupKey, g] of groups.entries()) {
            const totalQty = g.items.reduce((s, it) => s + it.qty, 0);
            if (totalQty <= 0) continue;

            const eco = g.economy;
            const add = g.additional;
            const addUnits = Math.max(0, totalQty - 1);

            const shippingTotal = eco + add * addUnits;
            orderTotalBaseCost += shippingTotal;

            let economyAssigned = false;
            let remainingAdditionalUnits = addUnits;

            const sorted = [...g.items].sort((a, b) => String(a.orderItemId).localeCompare(String(b.orderItemId)));

            for (const it of sorted) {
                const out = perItemResults.find(r => r.orderItemId === it.orderItemId);
                if (!out || out.status !== 'ok') continue;

                let ecoForThisItem = 0;
                if (!economyAssigned && it.qty > 0) {
                    ecoForThisItem = eco;
                    economyAssigned = true;
                }

                let addUnitsForThisItem = it.qty - (ecoForThisItem > 0 ? 1 : 0);
                addUnitsForThisItem = Math.max(0, Math.min(addUnitsForThisItem, remainingAdditionalUnits));
                remainingAdditionalUnits -= addUnitsForThisItem;

                const addCostForThisItem = addUnitsForThisItem * add;

                out.shipping_international_economy = ecoForThisItem;
                out.shipping_international_additional_units = addUnitsForThisItem;
                out.shipping_international_additional_rate = add;
                out.base_cost_total_for_item_including_shipping = Number(
                    (out.base_cost_total_for_item_including_shipping + ecoForThisItem + addCostForThisItem).toFixed(2)
                );
                out.formula = `(base ${it.baseEach} * qty ${it.qty}) + eco ${ecoForThisItem} + add ${add} * ${addUnitsForThisItem}`;
            }

            groupBreakdowns.push({
                group_key: groupKey,
                total_qty: totalQty,
                shipping_economy_once: eco,
                shipping_additional_rate: add,
                shipping_additional_units: addUnits,
                shipping_total_for_group: Number(shippingTotal.toFixed(2))
            });
        }

        // ================== BƯỚC 5: LƯU BREAKDOWN VÀO MODEL ==================
        // Ghi breakdown từng item vào order.items[].cost_breakdown
        for (const out of perItemResults) {
            if (out.status !== 'ok') continue; // chỉ lưu khi match thành công
            const itemRef = order.items.find(i => String(i.orderItemId) === String(out.orderItemId));
            if (!itemRef) continue;

            itemRef.cost_breakdown = {
                configCode: out.configCode,
                productTypeValue: out.productTypeValue || null,
                selectedConfigBy: out.selectedConfigBy || null,
                sizeValue: out.sizeValue,
                colorValue: out.colorValue,
                vendorProductId: out.vendorProductId || null,
                matchedSku: out.matchedSku || null,
                base_cost_each: out.base_cost_each,
                quantity: out.quantity,
                shipping_international_economy: out.shipping_international_economy,
                shipping_international_additional_units: out.shipping_international_additional_units,
                shipping_international_additional_rate: out.shipping_international_additional_rate,
                base_cost_total_for_item_including_shipping: out.base_cost_total_for_item_including_shipping,
                formula: out.formula
            };
        }

        // Lưu breakdown nhóm ship ở cấp order
        order.base_cost_shipping_groups = groupBreakdowns;

        // Tổng tiền và thời điểm tính
        order.base_cost = Number(orderTotalBaseCost.toFixed(2));
        order.base_cost_computed_at = new Date();

        await order.save();
        // ================== HẾT BƯỚC 5 ==================

        return res.json({
            message: 'Computed base cost',
            orderId,
            base_cost: order.base_cost,
            shipping_group_breakdowns: groupBreakdowns,
            detail: perItemResults
        });
    } catch (err) {
        return res.status(500).json({ message: 'Compute failed', error: err.message });
    }
};

/**
 * POST body: { limit?: number }
 * Tính cho nhiều đơn còn thiếu base_cost (0/null), giới hạn tối đa 200
 */
const computeBaseCostForMany = async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(200, Number(req.body?.limit || 50)));
        const orders = await OrderCustomProduct.find({
            $or: [{ base_cost: { $exists: false } }, { base_cost: { $in: [0, null] } }]
        }).sort({ createdAt: -1 }).limit(limit);

        const results = [];
        for (const o of orders) {
            const fakeReq = { body: { orderId: o.orderId } };
            const fakeRes = {
                json: (r) => results.push({ orderId: o.orderId, ...r }),
                status: (code) => ({ json: (r) => results.push({ orderId: o.orderId, code, ...r }) })
            };
            // eslint-disable-next-line no-await-in-loop
            await computeBaseCostForOrder(fakeReq, fakeRes);
        }
        return res.json({ message: 'Batch computed', count: results.length, results });
    } catch (err) {
        return res.status(500).json({ message: 'Batch compute failed', error: err.message });
    }
};
// ================== END BASE COST ==================



module.exports = {
    importOrderFromFile,
    getAllOrders,
    getOrderById,
    getFrontendOrders,
    upload,
    updateOrdersFromXlsx,
    updateOrderStatus,
    updateShippingType,
    updateBaseCost,
    updateCustomerInfo,
    openCaseInOrder,
    getOrderStatistics,
    removeCaseFromOrder,
    updateBaseImageUrl,
    computeBaseCostForOrder,
    computeBaseCostForMany
};
