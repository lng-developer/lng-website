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

const shopifyItemSchema = new mongoose.Schema(
  {
    shopifyLineItemGid: String,
    shopifyLineItemId: String,
    name: String,
    title: String,
    sku: String,
    quantity: Number,
    variantTitle: String,
    originalUnitPrice: moneySetSchema,
    customAttributes: [shopifyCustomAttributeSchema],
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
