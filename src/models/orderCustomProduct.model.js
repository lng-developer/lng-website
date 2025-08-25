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
    productTypeValue: String,
    selectedConfigBy: String,
    sizeValue: String,
    colorValue: String,
    vendorProductId: String,
    matchedSku: String,

    // ✅ NEW: Priority selection info
    selectedOrder: { type: Number, default: null }, // Order priority (1, 2, 3...) của item được chọn
    itemDisplayName: String,                         // Display name của item được chọn

    base_cost_each: Number,
    quantity: Number,

    // Additional costs breakdown
    additional_costs_breakdown: {
        embroidery: { type: Number, default: 0 },
        two_sided_print: { type: Number, default: 0 },
        two_position_print: { type: Number, default: 0 }
    },
    total_additional_cost_per_item: { type: Number, default: 0 },

    // Shipping fields
    shipping_international_economy: Number,
    shipping_international_additional_units: Number,
    shipping_international_additional_rate: Number,

    base_cost_total_for_item_including_shipping: Number,
    formula: String  // Bao gồm thông tin về selection priority                        
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

    fulfillment_file: { type: String, default: '' },

    scale_status: {
        type: String,
        enum: ["Need Scale", "Pending", "Complete", "QC Rejected"],
        default: "Need Scale"
    },

    qc_note: { type: String, trim: true, default: '' },
    cs_note: { type: String, trim: true, default: '' },

    totalCustomizationPrice: { type: Number, default: 0 },
    customized_url: String,
    asin: String,

    cost_breakdown: itemCostBreakdownSchema,
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
    },
    scale_overall_status: {
        type: String,
        enum: ["Need Scale", "Pending", "Ready", "Sent", "Failed", "QC Rejected"],
        default: "Need Scale",
        index: true
    },

    // Theo dõi việc gửi đi Grabink để idempotent/trace
    grabink_submission: {
        sent: { type: Boolean, default: false },
        sent_at: { type: Date, default: null },
        attempt_count: { type: Number, default: 0 },
        last_response: { type: Object, default: null },
        external_id: { type: String, default: null } // [Chưa xác minh]: nếu Grabink trả ID
    }
});

// Tối ưu truy vấn theo orderId + orderItemId
orderCustomProductSchema.index({ orderId: 1, "items.orderItemId": 1 });

module.exports = mongoose.model('OrderCustomProduct', orderCustomProductSchema);
