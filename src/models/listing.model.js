const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema({
    asin: { type: String, required: true, unique: true },
    product_image: { type: String },
    total_sales: { type: Number, default: 0 },

    date_updated: { type: Date, default: Date.now },
    template: {
        style: String,
        sub_style: String,
        design_product: String,
        variant: { type: String, default: 'All' }
    },

    psd: {
        psd_id: String,
        status: { type: String, enum: ['Available', 'Unavailable'], default: 'Unavailable' }
    },

    store: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shop'
    },
    platform: { type: String, default: 'Amazon' },
    seller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },

    thread_color: String, // e.g. "No config", "Customize Key", ...
    thread_note: String,  // optional: thêm ghi chú cho thread nếu có

    asin_type: { type: String, enum: ['PODLovers', 'Normal', 'Outline', 'Style', 'Tool', 'Custom Image', 'Auto Fulfill', 'Other'], default: 'Normal' },

    other_config: String,
}, { timestamps: true });

module.exports = mongoose.model('Listing', listingSchema);
