const mongoose = require("mongoose");

const etsyListingSchema = new mongoose.Schema(
    {
        shopId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Shop",
            index: true,
        },
        etsyShopId: { type: String, index: true },
        shopName: { type: String, default: "" },
        listingId: { type: String, index: true },
        title: { type: String, default: "" },
        url: { type: String, default: "" },
        imageUrl: { type: String, default: "" },
        TITLE: { type: String, default: "" },
        IMAGE1: { type: String, default: "" },
        IMAGE2: { type: String, default: "" },
        IMAGE3: { type: String, default: "" },
        IMAGE4: { type: String, default: "" },
        IMAGE5: { type: String, default: "" },
        IMAGE6: { type: String, default: "" },
        IMAGE7: { type: String, default: "" },
        IMAGE8: { type: String, default: "" },
        IMAGE9: { type: String, default: "" },
        IMAGE10: { type: String, default: "" },
        SKU: { type: String, default: "" },
        sku: { type: String, default: "" },
        skus: { type: [String], default: [] },
        skuSource: { type: String, default: "" },
        raw: { type: mongoose.Schema.Types.Mixed, default: null },
        syncedAt: { type: Date },
        designFile: {
            key: { type: String, default: "" },
            url: { type: String, default: "" },
            fileName: { type: String, default: "" },
            fileExt: { type: String, default: ".zip" },
            mime: { type: String, default: "" },
            size: { type: Number, default: 0 },
            uploadedAt: { type: Date },
        },
    },
    { timestamps: true }
);

etsyListingSchema.index(
    { shopId: 1, listingId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            shopId: { $exists: true },
            listingId: { $type: "string" },
        },
    }
);
etsyListingSchema.index({ shopId: 1, SKU: 1 });

module.exports = mongoose.model("EtsyListing", etsyListingSchema);
