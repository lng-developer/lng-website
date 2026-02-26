const mongoose = require("mongoose");

const etsyListingSchema = new mongoose.Schema(
    {
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
    },
    { timestamps: true }
);

module.exports = mongoose.model("EtsyListing", etsyListingSchema);
