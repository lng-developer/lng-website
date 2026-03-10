// models/listing.js
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
        variant: { type: String, default: 'All' },
    },

    psd: {
        psd_id: String,  // trùng ASIN
        url: String,     // link tải từ Wasabi (qua signed URL)
        status: {
            type: String,
            enum: ['Available', 'Unavailable'],
            default: 'Unavailable',
        },
        // 🔽 mới thêm
        file_name: String,   // tên gốc khi upload
        file_ext: { type: String, enum: ['.psd', '.zip', '.rar'], default: '.psd' },
        mime: String,        // content-type thực tế
        size: Number,        // dung lượng file (bytes)
        archive: { type: Boolean, default: false }, // true nếu là zip/rar
    },

    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' },
    platform: { type: String, default: 'Amazon' },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    thread_color: String,
    thread_note: String,
    asin_type: {
        type: String,
        enum: [
            'PODLovers',
            'Normal',
            'Outline',
            'Style',
            'Tool',
            'Custom Image',
            'Auto Fulfill',
            'Other',
        ],
        default: 'Normal',
    },
    other_config: String,
}, { timestamps: true });


module.exports = mongoose.model('Listing', listingSchema);

