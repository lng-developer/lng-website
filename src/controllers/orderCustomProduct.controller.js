const db = require('../models');
const OrderCustomProduct = db.orderCustomProduct;
const multer = require('multer');
const fs = require('fs');
const XLSX = require('xlsx');
const path = require('path');
const upload = multer({ dest: 'uploads/' });
const axios = require('axios');
const AdmZip = require('adm-zip');

const importOrderJson = async (req, res) => {
    try {
        const jsonData = req.body;
        const order = await OrderCustomProduct.findOne({ orderId: jsonData.orderId });
        if (!order) return res.status(404).json({ message: 'Order ID not found' });

        const item = order.items.find(i => i.orderItemId === jsonData.orderItemId);
        if (!item) return res.status(404).json({ message: 'OrderItem ID not found in Order' });

        let totalCustomizationPrice = 0;
        const options = jsonData?.customizationData?.children?.[0]?.children?.[0]?.children || [];

        options.forEach(opt => {
            const amount = opt?.optionSelection?.additionalCost?.amount || 0;
            totalCustomizationPrice += Number(amount);
        });

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

        const imageCustomization = options.find(opt => opt?.type === "PlacementContainerCustomization");
        const imageData = imageCustomization?.children?.[0]?.image || {};

        customizationOptions.photoUploaded = {
            imageName: imageData?.imageName || "",
            buyerFilename: imageData?.buyerFilename || ""
        };
        item.asin = jsonData.asin;
        item.customization = customizationOptions;
        item.customizationData = jsonData.customizationData || null;
        item.version3Data = jsonData["version3.0"] || null;
        item.baseImage = {
            imageUrl: jsonData?.customizationData?.children?.[0]?.baseImage?.imageUrl || "",
            width: jsonData?.customizationData?.children?.[0]?.baseImage?.dimension?.width || null,
            height: jsonData?.customizationData?.children?.[0]?.baseImage?.dimension?.height || null
        };
        item.snapshotImage = jsonData?.customizationData?.children?.[0]?.snapshot?.imageName || "";
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
const updateOrdersFromXlsx = async (req, res) => {
    try {
        const filePath = req.file.path;
        const ext = path.extname(req.file.originalname).toLowerCase();
        let rows = [];
        const shopId = req.body.shopId;

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
            if (existing) {
                const exists = existing.items.some(i => i.orderItemId === itemData.orderItemId);
                if (!exists) {
                    existing.items.push(itemData);
                    await existing.save();
                }
            } else {
                await new OrderCustomProduct({ ...basicData, items: [itemData] }).save();
            }

            try {
                const url = row.customized_url;
                if (!url) {
                    results.push({ orderId, status: 'no URL' });
                    continue;
                }

                const zipResponse = await axios.get(url, { responseType: 'arraybuffer' });
                const zip = new AdmZip(Buffer.from(zipResponse.data));

                // ✅ Extract .png images
                const imageEntries = zip.getEntries().filter(entry => entry.entryName.endsWith('.jpg' || '.png'));
                const imageUrls = [];

                for (const imageEntry of imageEntries) {
                    const imageBuffer = imageEntry.getData();
                    const imageName = path.basename(imageEntry.entryName);
                    const imageDir = path.join(__dirname, '../public/uploads/images');
                    const imagePath = path.join(imageDir, imageName);

                    fs.mkdirSync(imageDir, { recursive: true });
                    fs.writeFileSync(imagePath, imageBuffer);

                    const publicUrl = `/uploads/images/${imageName}`;
                    imageUrls.push(publicUrl);
                }

                // ✅ Extract .json and process
                const jsonEntry = zip.getEntries().find(entry => entry.entryName.endsWith('.json'));
                if (!jsonEntry) {
                    results.push({ orderId, status: 'no JSON in ZIP', images: imageUrls });
                    continue;
                }

                const jsonData = JSON.parse(zip.readAsText(jsonEntry));
                const fakeReq = { body: jsonData };
                const fakeRes = {
                    status: code => ({
                        json: msg => results.push({
                            orderId,
                            status: code,
                            message: msg?.message || msg,
                            images: imageUrls
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
        const { status, search } = req.query;
        let filter = {};

        if (status) {
            filter.status = status;
        }

        if (search) {
            const keyword = new RegExp(search, 'i');
            filter.$or = [
                { orderId: keyword },
                { 'customer_infor.name': keyword }
            ];
        }

        const orders = await OrderCustomProduct.find(filter)
            .populate('shopId', 'name')
            .sort({ createdAt: -1 });

        const result = orders.map(order => {
            const items = order.items.map(item => {
                const areas = item.version3Data?.customizationInfo?.surfaces?.[0]?.areas || [];
                const version3Data = areas.map(area => {
                    const label = area.label || area.name || '';
                    const value = area.optionValue || area.text || '';
                    return { label, value };
                });

                // ✅ lấy snapshot từ customizationData nếu có
                let snapshotImage = null;
                try {
                    const previewContainers = item.customizationData?.children || [];
                    for (const container of previewContainers) {
                        if (container?.snapshot?.imageName) {
                            snapshotImage = container.snapshot.imageName;
                            break;
                        }
                    }
                } catch (e) {
                    snapshotImage = null;
                }

                return {
                    orderItemId: item.orderItemId || null,
                    sku: item.sku,
                    title: item.title || '',
                    quantity: item.quantity || 1,
                    version3Data,
                    baseImageUrl: item.baseImage?.imageUrl || null,
                    snapshotImage: snapshotImage ? `https://lng-website-production.up.railway.app/uploads/images/${snapshotImage}` : null,
                    totalCustomizationPrice: item.totalCustomizationPrice || 0,
                    asin: item.asin,
                    customized_url: item.customized_url
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
                shopName: order.shopId?.name || null,
                shipping_type: order.shipping_type || null,
                items,
                base_cost: order.base_cost
            };
        });

        res.json(result);
    } catch (error) {
        res.status(500).json({ message: 'Failed to retrieve frontend orders', error: error.message });
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
        const allowedShippingType = ["Second Day", "Ground", "Overngight", "Economy", "Standard"];

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
    updateCustomerInfo
};
