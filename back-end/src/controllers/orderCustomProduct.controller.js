const db = require('../models');
const OrderCustomProduct = db.orderCustomProduct;
const multer = require('multer');
const fs = require('fs');
const XLSX = require('xlsx');
const path = require('path');
const upload = multer({ dest: 'uploads/' });

const importOrderJson = async (req, res) => {
    try {
        const jsonData = req.body;

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

        // Lấy ảnh khách upload
        const imageCustomization = options.find(opt => opt?.type === "PlacementContainerCustomization");
        const imageData = imageCustomization?.children?.[0]?.image || {};

        customizationOptions.photoUploaded = {
            imageName: imageData?.imageName || "",
            buyerFilename: imageData?.buyerFilename || ""
        };

        const order = new OrderCustomProduct({
            orderId: jsonData.orderId,
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
        });

        await order.save();

        res.status(201).json({
            message: 'Order imported successfully!',
            id: order._id
        });

    } catch (error) {
        res.status(500).json({
            message: 'Failed to import order',
            error: error.message
        });
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
        const ext = path.extname(req.file.originalname).toLowerCase();  // Sửa dòng này
        let rows = [];

        if (ext === '.txt') {
            const raw = fs.readFileSync(filePath, 'utf8');
            const delimiter = raw.includes('\t') ? '\t' : ',';
            const lines = raw.split('\n').filter(Boolean);

            // Xử lý header: loại bỏ khoảng trắng và thay "-" thành "_"
            const rawHeaders = lines[0].trim().split(delimiter);
            const headers = rawHeaders.map(h => h.trim().replace(/-/g, '_'));

            // Parse từng dòng thành object
            rows = lines.slice(1).map(line => {
                const values = line.trim().split(delimiter);
                const obj = {};
                headers.forEach((key, index) => {
                    obj[key] = values[index]?.trim() || '';
                });
                return obj;
            });
        } else if (ext === '.xlsx') {
            const workbook = XLSX.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
        } else {
            return res.status(400).json({ message: 'Unsupported file type. Please upload .xlsx or .txt files.' });
        }

        const results = [];

        for (const row of rows) {
            const orderId = row.order_id || row.orderId;
            if (!orderId) continue;

            const updateData = {
                sku: row.sku,
                customer_infor: {
                    email: row.buyer_email,
                    name: row.buyer_name,
                    phone_number: row.buyer_phone_number
                }
            };

            const updated = await OrderCustomProduct.findOneAndUpdate(
                { orderId },
                updateData,
                { new: true }
            );

            results.push({ orderId, status: updated ? 'updated' : 'not found' });
        }

        fs.unlinkSync(filePath);
        res.json({ message: "Batch update completed", results });
    } catch (error) {
        res.status(500).json({ message: "Batch update failed", error: error.message });
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
        const orders = await OrderCustomProduct.find().sort({ createdAt: -1 });
        const result = orders.map(order => {
            // Rút gọn version3Data nếu có
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
                title: order.title || '',
                quantity: order.quantity || 1,
                version3Data,
                baseImageUrl: order.baseImage?.imageUrl || null,
                snapshotImage: order.snapshotImage || null,
                totalCustomizationPrice: order.totalCustomizationPrice || 0
            };
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: 'Failed to retrieve frontend orders', error: error.message });
    }
};




module.exports = {
    importOrderFromFile,
    getAllOrders,
    getOrderById,
    getFrontendOrders,
    upload,
    updateOrdersFromXlsx
};
