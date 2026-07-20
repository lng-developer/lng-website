const mongoose = require("mongoose");

const moneySetSchema = new mongoose.Schema(
  {
    amount: String,
    currencyCode: String,
    shopAmount: String,
    shopCurrencyCode: String,
  },
  { _id: false }
);

const shopifyCustomerSchema = new mongoose.Schema(
  {
    id: String,
    email: String,
    phone: String,
    firstName: String,
    lastName: String,
    displayName: String,
  },
  { _id: false }
);

const shopifyShippingAddressSchema = new mongoose.Schema(
  {
    name: String,
    firstName: String,
    lastName: String,
    company: String,
    address1: String,
    address2: String,
    city: String,
    province: String,
    provinceCode: String,
    zip: String,
    country: String,
    countryCode: String,
    phone: String,
  },
  { _id: false }
);

const shopifyCustomAttributeSchema = new mongoose.Schema(
  {
    key: String,
    value: String,
    source: {
      type: String,
      default: "shopify_line_item_custom_attributes",
    },
  },
  { _id: false }
);

const shopifyImageSchema = new mongoose.Schema(
  {
    url: String,
    altText: String,
    width: Number,
    height: Number,
    source: String,
  },
  { _id: false }
);

const shopifyCustomFileSchema = new mongoose.Schema(
  {
    key: String,
    url: String,
    type: {
      type: String,
    },
    source: String,
  },
  { _id: false }
);

const shopifyCustomTextSchema = new mongoose.Schema(
  {
    key: String,
    value: String,
    source: String,
  },
  { _id: false }
);

const shopifySelectedOptionSchema = new mongoose.Schema(
  {
    name: String,
    value: String,
  },
  { _id: false }
);

const shopifySkuInfoSchema = new mongoose.Schema(
  {
    sku: String,
    variantSku: String,
    productId: String,
    productGid: String,
    productTitle: String,
    productHandle: String,
    productVendor: String,
    productType: String,
    lineItemId: String,
    lineItemGid: String,
  },
  { _id: false }
);

const shopifyVariantInfoSchema = new mongoose.Schema(
  {
    variantId: String,
    variantGid: String,
    title: String,
    sku: String,
    barcode: String,
    price: String,
    selectedOptions: [shopifySelectedOptionSchema],
  },
  { _id: false }
);

const shopifyCustomizationSchema = new mongoose.Schema(
  {
    attributes: [shopifyCustomAttributeSchema],
    files: [shopifyCustomFileSchema],
    texts: [shopifyCustomTextSchema],
    customall: {
      previewUrl: String,
      printFileUrls: [String],
      customizedUrl: String,
      customId: String,
    },
  },
  { _id: false }
);

const shopifyItemSchema = new mongoose.Schema(
  {
    shopifyLineItemGid: String,
    shopifyLineItemId: String,
    name: String,
    title: String,
    sku: String,
    quantity: Number,
    variantTitle: String,
    img: String,
    imageUrl: String,
    variantImageUrl: String,
    productImageUrl: String,
    productImage: shopifyImageSchema,
    skuInfo: shopifySkuInfoSchema,
    variantInfo: shopifyVariantInfoSchema,
    customization: shopifyCustomizationSchema,
    originalUnitPrice: moneySetSchema,
    customAttributes: [shopifyCustomAttributeSchema],
    customFiles: [shopifyCustomFileSchema],
    rawLineItem: Object,
  },
  { _id: false }
);

const orderProductShopifySchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      default: "shopify",
      index: true,
    },

    shopDomain: {
      type: String,
      index: true,
    },

    shopifyOrderGid: {
      type: String,
      required: true,
      index: true,
    },

    shopifyOrderId: {
      type: String,
      required: true,
      index: true,
    },

    shopifyOrderName: {
      type: String,
      index: true,
    },

    duplicateKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    financialStatus: String,
    fulfillmentStatus: String,
    fulfillmentOrderId: String,

    trackingInfo: {
      fulfillmentId: String,
      status: String,
      trackingNumber: String,
      trackingCompany: String,
      trackingUrl: String,
      createdAt: Date,
      updatedAt: Date,
    },

    purchaseDate: Date,
    updatedAtShopify: Date,

    email: String,
    phone: String,

    customer: shopifyCustomerSchema,
    shippingAddress: shopifyShippingAddressSchema,
    billingAddress: shopifyShippingAddressSchema,
    totalPrice: moneySetSchema,
    items: [shopifyItemSchema],

    rawShopifyOrder: Object,

    importStatus: {
      type: String,
      enum: ["preview", "imported", "skipped", "failed"],
      default: "imported",
      index: true,
    },

    processStatus: {
      type: String,
      enum: ["new", "mapped", "need_review", "ready_for_fulfillment", "cancelled"],
      default: "new",
      index: true,
    },

    lastImportAt: Date,
    lastShopifySyncAt: Date,
    errorMessage: String,
  },
  { timestamps: true, collection: "orderproducshopify" }
);

orderProductShopifySchema.index({ purchaseDate: 1 });
orderProductShopifySchema.index({ financialStatus: 1 });
orderProductShopifySchema.index({ fulfillmentStatus: 1 });

module.exports = mongoose.model("OrderProductShopify", orderProductShopifySchema);
