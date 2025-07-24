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

const orderCustomProductSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    orderItemId: { type: String },
    merchantId: { type: String },
    marketplaceId: { type: String },
    asin: { type: String },
    sku: { type: String },
    title: { type: String },
    quantity: { type: Number },
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
    vendorProduct: {
        name: String,
        size: String,
        color: String
    },

    customization: customizationSchema,

    customizationData: {
        type: Object,
        default: null
    },

    version3Data: {
        type: Object,
        default: null
    },

    baseImage: {
        imageUrl: String,
        width: Number,
        height: Number
    },
    status: {
        type: String,
        enum: ["New", "Fulfilled", "Shipped", "Cancelled"],
        default: "New"
    },
    snapshotImage: String,
    svgFile: String,
    customized_url: String,
    totalCustomizationPrice: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now },
    purchase_date: { type: Date },
    store: String
});

module.exports = mongoose.model('OrderCustomProduct', orderCustomProductSchema);
