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
        const existingOrder = await OrderCustomProduct.findOne({ orderId: jsonData.orderId });
        if (!existingOrder) {
            return res.status(404).json({ message: 'Order ID not found in DB' });
        }

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

        const updateFields = {
            orderItemId: jsonData.orderItemId,
            merchantId: jsonData.merchantId,
            marketplaceId: jsonData.marketplaceId,
            asin: jsonData.asin,
            title: jsonData.title,
            quantity: jsonData.quantity,
            customization: customizationOptions,
            customizationData: jsonData.customizationData || null,
            version3Data: jsonData["version3.0"] || null,
            baseImage: {
                imageUrl: jsonData?.customizationData?.children?.[0]?.baseImage?.imageUrl || "",
                width: jsonData?.customizationData?.children?.[0]?.baseImage?.dimension?.width || null,
                height: jsonData?.customizationData?.children?.[0]?.baseImage?.dimension?.height || null
            },
            snapshotImage: jsonData?.customizationData?.children?.[0]?.snapshot?.imageName || "",
            svgFile: jsonData?.customizationData?.children?.[0]?.svg || "",
            totalCustomizationPrice
        };

        await OrderCustomProduct.updateOne({ orderId: jsonData.orderId }, updateFields);
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
        console.log("rows:" + rows[1].order_id);

        const results = [];
        for (const row of rows) {
            const orderId = row.order_id || row.orderId;

            if (!orderId) continue;

            const basicData = {
                orderId,
                sku: row.sku,
                shopId,
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
                customized_url: row.customized_url,
                purchase_date: row.purchase_date
            };

            const existing = await OrderCustomProduct.findOne({ orderId });
            if (existing) {
                await OrderCustomProduct.updateOne({ orderId }, basicData);
            } else {
                const newOrder = new OrderCustomProduct(basicData);
                await newOrder.save();
            }
            // Step 2: Fetch and process JSON
            try {
                const url = row.customized_url;
                if (!url) {
                    results.push({ orderId, status: 'no URL' });
                    continue;
                }

                const zipResponse = await axios.get(url, { responseType: 'arraybuffer' });
                const zip = new AdmZip(Buffer.from(zipResponse.data));
                const zipEntries = zip.getEntries();
                const jsonEntry = zipEntries.find(entry => entry.entryName.endsWith('.json'));
                if (!jsonEntry) {
                    results.push({ orderId, status: 'no JSON in ZIP' });
                    continue;
                }

                const jsonContent = zip.readAsText(jsonEntry);
                const jsonData = JSON.parse(jsonContent);

                const fakeReq = { body: jsonData };
                const fakeRes = {
                    status: code => ({
                        json: msg => results.push({ orderId, status: code, message: msg?.message || msg })
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

const getFrontendOrders = async (req, res) => {
    try {
        const { status } = req.query;
        let filter = {};

        // Nếu có truyền status thì lọc theo status
        if (status) {
            filter.status = status;
        }

        const orders = await OrderCustomProduct.find(filter)
            .populate('shopId', 'name')
            .sort({ createdAt: -1 });


        const result = orders.map(order => {
            let version3Data = [];
            const areas = order.version3Data?.customizationInfo?.surfaces?.[0]?.areas || [];

            version3Data = areas.map(area => {
                const label = area.label || area.name || '';
                const value = area.optionValue || area.text || '';
                return { label, value };
            });

            return {
                orderId: order.orderId,
                orderItemId: order.orderItemId || null,
                merchantId: order.merchantId || null,
                marketplaceId: order.marketplaceId || null,
                asin: order.asin,
                sku: order.sku,
                title: order.title || '',
                quantity: order.quantity || 1,
                customer_infor: order.customer_infor,
                status: order.status || '', // Đảm bảo trả ra status
                version3Data,
                baseImageUrl: order.baseImage?.imageUrl || null,
                snapshotImage: order.snapshotImage || null,
                totalCustomizationPrice: order.totalCustomizationPrice || 0,
                customized_url: order.customized_url,
                purchase_date: order.purchase_date,
                createdAt: order.createdAt,
                shopName: order.shopId?.name
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





module.exports = {
    importOrderFromFile,
    getAllOrders,
    getOrderById,
    getFrontendOrders,
    upload,
    updateOrdersFromXlsx,
    updateOrderStatus
};
