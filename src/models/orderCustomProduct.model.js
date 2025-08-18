// ✅ orderCustomProduct.model.js
const mongoose = require('mongoose');

/**
 * Sub-schemas for customization detail
 */
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

/**
 * Cost breakdown (per item) saved after base-cost computation
 */
const itemCostBreakdownSchema = new mongoose.Schema({
    configCode: String,
    productTypeValue: String,                 // value from customize_product_type_key
    selectedConfigBy: String,                 // 'product_type_exact' | 'single_candidate_fallback' | ...
    sizeValue: String,                        // normalized value used to match
    colorValue: String,                       // normalized value used to match
    vendorProductId: String,
    matchedSku: String,
    base_cost_each: Number,
    quantity: Number,
    shipping_international_economy: Number,   // economy applied to this item (0 or >0 for first item in group)
    shipping_international_additional_units: Number, // how many "additional" units this item accounts for
    shipping_international_additional_rate: Number,  // rate used for additional units
    base_cost_total_for_item_including_shipping: Number,
    formula: String                           // human-readable formula used
}, { _id: false });

/**
 * Shipping group breakdown at order level (grouped by vendor_product)
 */
const shippingGroupSchema = new mongoose.Schema({
    group_key: String,                 // vendorProductId
    total_qty: Number,
    shipping_economy_once: Number,
    shipping_additional_rate: Number,
    shipping_additional_units: Number,
    shipping_total_for_group: Number
}, { _id: false });

// ⬇️ Tracking & Note per item
const itemTrackingSchema = new mongoose.Schema({
    fulfillment: { type: String, trim: true, default: '' }, // mã/đơn fulfill hoặc tên nhà fulfill
    tracking: { type: String, trim: true, default: '' }, // mã tracking
    status: {
        type: String,
        enum: ["New", "Fulfilled", "Shipped", "Cancelled"],   // giữ đồng bộ với Order.status
        default: "New"
    },
    note: { type: String, trim: true, default: '' },
    updated_at: { type: Date, default: Date.now }
}, { _id: false });

/** Order item schema */
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
    asin: String,

    // ⬇️ Saved result of base cost computation per item
    cost_breakdown: itemCostBreakdownSchema,

    // ⬇️ NEW: Tracking & Note
    tracking_info: itemTrackingSchema
}, { _id: false });


/**
 * Order schema
 */
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

    // Total base cost for the order (including shipping allocation)
    base_cost: Number,
    base_cost_computed_at: { type: Date },           // when the base cost was computed
    base_cost_shipping_groups: [shippingGroupSchema],// shipping breakdown per vendor_product group

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
    ],

    address_validation: {
        isValid: { type: Boolean, default: null },
        smartyResponse: { type: Object, default: null }
    }
});

// Tối ưu truy vấn theo orderId + orderItemId
orderCustomProductSchema.index({ orderId: 1, "items.orderItemId": 1 });

module.exports = mongoose.model('OrderCustomProduct', orderCustomProductSchema);
