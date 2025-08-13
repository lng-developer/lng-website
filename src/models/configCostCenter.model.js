// models/configCostCenter.model.js
const mongoose = require('mongoose');

function normalizeKeyInput(v) {
    if (Array.isArray(v)) return [...new Set(v.map(s => String(s).trim()).filter(Boolean))];
    if (typeof v === 'string') {
        try { // nếu gửi dạng JSON string
            const arr = JSON.parse(v);
            if (Array.isArray(arr)) return normalizeKeyInput(arr);
        } catch (_) { }
        return [...new Set(v.split(/[,|]/).map(s => s.trim()).filter(Boolean))];
    }
    return [];
}

const configCostCenterSchema = new mongoose.Schema({
    platform: { type: String, required: true, enum: ['Amazon', 'Ebay', 'Etsy', 'Facebook', 'Shopbase', 'Shopify', 'Tiktok', 'Woocommerce'], default: 'Amazon' },
    config_code: { type: String, required: true, trim: true, index: true },
    
    // Đổi sang mảng
    customize_size_key: { type: [String], default: [] },
    customize_color_key: { type: [String], default: [] },
    customize_product_type_key: { type: [String], default: [] },
    customize_product_type_size_key: { type: [String], default: [] },
    customize_product_type_color_key: { type: [String], default: [] },
    combination_product_type_key: { type: [String], default: [] },

    size_position: { type: Number, default: 0, min: 0 },
    color_position: { type: Number, default: 0, min: 0 },
    product_type_from_platform: { type: String, default: '' },
    country: { type: String, required: true, default: 'United States' },
    product_for_seller: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductTypeGroup' },
    default_color: { type: String, default: '' },
    is_set: { type: Boolean, default: false },
    is_pack: { type: Boolean, default: false },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true },
    history: [{ action: String, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, diff: mongoose.Schema.Types.Mixed }],
    is_deleted: { type: Boolean, default: false, index: true }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

configCostCenterSchema.index({ platform: 1, status: 1, is_deleted: 1 });
configCostCenterSchema.index({ config_code: 1 }, { unique: true });

// Nhận cả string/array khi ghi
const KEY_FIELDS = [
    'customize_size_key',
    'customize_color_key',
    'customize_product_type_key',
    'customize_product_type_size_key',
    'customize_product_type_color_key',
    'combination_product_type_key'
];

configCostCenterSchema.pre('save', function (next) {
    for (const f of KEY_FIELDS) this[f] = normalizeKeyInput(this[f]);
    next();
});

configCostCenterSchema.pre('findOneAndUpdate', function (next) {
    const update = this.getUpdate() || {};
    for (const f of KEY_FIELDS) {
        if (update.$set && f in update.$set) update.$set[f] = normalizeKeyInput(update.$set[f]);
        if (f in update) update[f] = normalizeKeyInput(update[f]);
    }
    next();
});

module.exports = mongoose.model('ConfigCostCenter', configCostCenterSchema);
