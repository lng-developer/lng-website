// ✅ orderCustomProduct.model.js
const mongoose = require("mongoose");

/**
 * Sub-schemas for customization detail
 */
const customizationOptionSchema = new mongoose.Schema(
  {
    name: String,
    label: String,
    displayValue: String,
    optionValue: String,
    additionalCost: {
      amount: { type: Number, default: 0 },
    },
    thumbnailImage: {
      imageUrl: String,
      dimension: {
        width: Number,
        height: Number,
      },
    },
  },
  { _id: false }
);

const imageUploadSchema = new mongoose.Schema(
  {
    imageName: String,
    buyerFilename: String,
  },
  { _id: false }
);

const customizationSchema = new mongoose.Schema(
  {
    customName: String,
    textColor: String,
    photoOptions: String,
    photoQualityEnhancement: customizationOptionSchema,
    sizeOption: customizationOptionSchema,
    packOption: customizationOptionSchema,
    priorityProduction: customizationOptionSchema,
    thankYouMessage: customizationOptionSchema,
    photoUploaded: imageUploadSchema,
  },
  { _id: false }
);

/**
 * Cost breakdown (per item) saved after base-cost computation
 */
const itemCostBreakdownSchema = new mongoose.Schema(
  {
    configCode: String,
    productTypeValue: String,
    selectedConfigBy: String,
    sizeValue: String,
    colorValue: String,
    vendorProductId: String,
    matchedSku: String,

    // ✅ NEW: Priority selection info
    selectedOrder: { type: Number, default: null }, // Order priority (1, 2, 3...) của item được chọn
    itemDisplayName: String, // Display name của item được chọn

    base_cost_each: Number,
    quantity: Number,

    // Additional costs breakdown
    additional_costs_breakdown: {
      embroidery: { type: Number, default: 0 },
      two_sided_print: { type: Number, default: 0 },
      two_position_print: { type: Number, default: 0 },
    },
    total_additional_cost_per_item: { type: Number, default: 0 },

    // Shipping fields
    shipping_international_economy: Number,
    shipping_international_additional_units: Number,
    shipping_international_additional_rate: Number,

    base_cost_total_for_item_including_shipping: Number,
    formula: String, // Bao gồm thông tin về selection priority
  },
  { _id: false }
);

/**
 * Shipping group breakdown at order level (grouped by vendor_product)
 */
const shippingGroupSchema = new mongoose.Schema(
  {
    group_key: String, // vendorProductId
    total_qty: Number,
    shipping_economy_once: Number,
    shipping_additional_rate: Number,
    shipping_additional_units: Number,
    shipping_total_for_group: Number,
  },
  { _id: false }
);

// ⬇️ Tracking & Note per item
const itemTrackingSchema = new mongoose.Schema(
  {
    fulfillment: { type: String, trim: true, default: "" }, // mã/đơn fulfill hoặc tên nhà fulfill
    tracking: { type: String, trim: true, default: "" }, // mã tracking
    status: {
      type: String,
      enum: ["New", "Fulfilled", "Shipped", "Cancelled"], // giữ đồng bộ với Order.status
      default: "New",
    },
    note: { type: String, trim: true, default: "" },
    updated_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

/** Order item schema */
const orderItemSchema = new mongoose.Schema(
  {
    orderItemId: String,
    sku: String,
    mapped_sku: { type: String, default: null },
    title: String,
    quantity: Number,

    customization: customizationSchema,
    customizationData: { type: Object, default: null },
    version3Data: { type: Object, default: null },

    baseImage: {
      imageUrl: String,
      width: Number,
      height: Number,
    },
    snapshotImage: String,
    svgFile: String,

    fulfillment_file: {
      type: Map,
      of: String,
      default: {},
    },

    scale_status: {
      type: String,
      enum: ["Need Scale", "Pending", "Complete", "QC Rejected", "Cancelled"],
      default: "Need Scale",
    },

    qc_note: { type: String, trim: true, default: "" },
    cs_note: { type: String, trim: true, default: "" },

    totalCustomizationPrice: { type: Number, default: 0 },
    customized_url: String,
    asin: String,

    cost_breakdown: itemCostBreakdownSchema,
    tracking_info: itemTrackingSchema,
    listingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Listing",
      default: null,
    },
  },
  { _id: false }
);

const amazonFinanceTotalSchema = new mongoose.Schema(
  {
    // Tổng theo order (đã cộng dồn tất cả dòng của cùng order-id)
    item_price: { type: Number, default: 0 }, // tổng item-price
    item_tax: { type: Number, default: 0 }, // tổng item-tax
    shipping_price: { type: Number, default: 0 }, // tổng shipping-price
    shipping_tax: { type: Number, default: 0 }, // tổng shipping-tax
    item_promotion_discount: { type: Number, default: 0 }, // tổng item-promotion-discount

    // Theo công thức bạn dùng khi import: fee = 17% * (item_price + shipping_price)
    fee: { type: Number, default: 0 }, // tổng fee 17%
    revenue: { type: Number, default: 0 },
    opCost: { type: Number, default: 0 },
    refund: { type: Number, default: 0 },
    profit1: { type: Number, default: 0 },
    profit2: { type: Number, default: 0 }, // tổng revenue đã tính

    currency: { type: String, default: "USD" }, // nếu muốn lưu
    computed_at: { type: Date, default: null }, // thời điểm tính
  },
  { _id: false }
);

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
    phone_number: String,
  },

  status: {
    type: String,
    enum: ["New", "Fulfilled", "Shipped", "Cancelled", "Refund"],
    default: "New",
  },

  // Total base cost for the order (including shipping allocation)
  base_cost: Number,
  base_cost_computed_at: { type: Date }, // when the base cost was computed
  base_cost_shipping_groups: [shippingGroupSchema], // shipping breakdown per vendor_product group

  purchase_date: { type: Date },

  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Shop",
  },

  createdAt: { type: Date, default: Date.now },

  shipping_type: {
    type: String,
    enum: [
      "SecondDay",
      "Ground",
      "Overnight",
      "Economy",
      "Standard",
      "Expedited",
      "FreeEconomy"
    ],
    default: "Standard",
  },

  case: [{ type: mongoose.Schema.Types.ObjectId, ref: "Case", required: true }],

  address_validation: {
    isValid: { type: Boolean, default: null },
    smartyResponse: { type: Object, default: null },
  },
  scale_overall_status: {
    type: String,
    enum: [
      "Need Scale",
      "Pending",
      "Ready",
      "Sent",
      "Failed",
      "QC Rejected",
      "Cancelled",
      "Address Invalid"
    ],
    default: "Need Scale",
    index: true,
  },

  // Theo dõi việc gửi đi Grabink để idempotent/trace
  grabink_submission: {
    sent: { type: Boolean, default: false },
    sent_at: { type: Date, default: null },
    attempt_count: { type: Number, default: 0 },
    last_response: { type: Object, default: null },
    external_id: { type: String, default: null }, // [Chưa xác minh]: nếu Grabink trả ID
  },

  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },

  scaleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },

  // Tổng quantity của order trong file Amazon (không bắt buộc, chỉ để tham khảo)
  amazon_total_quantity: { type: Number, default: 0 },

  // Khối tổng hợp tài chính lấy từ Amazon settlement / CSV TXT
  amazon_finance_total: { type: amazonFinanceTotalSchema, default: () => ({}) },

  // Mốc đồng bộ gần nhất để bạn biết lần cuối import là khi nào
  last_amazon_finance_sync_at: { type: Date, default: null },
});

// Tối ưu truy vấn theo orderId + orderItemId
orderCustomProductSchema.index({ orderId: 1, "items.orderItemId": 1 });
orderCustomProductSchema.index({ status: 1, shopId: 1, createdAt: -1 });
orderCustomProductSchema.index({ sellerId: 1, status: 1, createdAt: -1 });
orderCustomProductSchema.index({ base_cost: 1 });
orderCustomProductSchema.index({ "items.asin": 1 });

module.exports = mongoose.model("OrderCustomProduct", orderCustomProductSchema);
