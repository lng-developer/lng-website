const mongoose = require("mongoose");

const shopifyStoreSchema = new mongoose.Schema(
  {
    shopDomain: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    accessToken: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      default: [],
    },
    installedAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "shopifyStore",
  }
);

module.exports = mongoose.model("ShopifyStore", shopifyStoreSchema);
