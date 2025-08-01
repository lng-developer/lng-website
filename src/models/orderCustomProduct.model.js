// ✅ orderCustomProduct.model.js
const mongoose = require('mongoose');

const customizationOptionSchema = new mongoose.Schema({
    name: String,
    label: String,
    displayValue: String,
    optionValue: String,
    additionalCost: {
        amount: { type: Number, default: 0 }
    },
    thumbnailImage: {
        imageUrl: String,
        dimension: {
            width: Number,
            height: Number
        }
    }
}, { _id: false });

const imageUploadSchema = new mongoose.Schema({
    imageName: String,
    buyerFilename: String
}, { _id: false });

const customizationSchema = new mongoose.Schema({
    customName: String,
    textColor: String,
    photoOptions: String,
    photoQualityEnhancement: customizationOptionSchema,
    sizeOption: customizationOptionSchema,
    packOption: customizationOptionSchema,
    priorityProduction: customizationOptionSchema,
    thankYouMessage: customizationOptionSchema,
    photoUploaded: imageUploadSchema
}, { _id: false });

const orderItemSchema = new mongoose.Schema({
    orderItemId: String,
    sku: String,
    title: String,
    quantity: Number,
    customization: customizationSchema,
    customizationData: { type: Object, default: null },
    version3Data: { type: Object, default: null },
    baseImage: {
        imageUrl: String,
        width: Number,
        height: Number
    },
    snapshotImage: String,
    svgFile: String,
    totalCustomizationPrice: { type: Number, default: 0 },
    customized_url: String,
    asin: String
}, { _id: false });

const orderCustomProductSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    items: [orderItemSchema],
    merchantId: String,
    marketplaceId: String,
    customer_infor: {
        email: String,
        name: String,
        address: String,
        address_2: String,
        province: String,
        city: String,
        state: String,
        zip_code: String,
        country: String,
        phone_number: String
    },
    status: {
        type: String,
        enum: ["New", "Fulfilled", "Shipped", "Cancelled"],
        default: "New"
    },
    base_cost: Number,
    purchase_date: { type: Date },
    shopId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shop'
    },
    createdAt: { type: Date, default: Date.now },
    shipping_type: {
        type: String,
        enum: ["Second Day", "Ground", "Overnight", "Economy", "Standard", "Expedited"],
        default: "Standard"
    },
    case: [
        { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true }
    ]
});

module.exports = mongoose.model('OrderCustomProduct', orderCustomProductSchema);
