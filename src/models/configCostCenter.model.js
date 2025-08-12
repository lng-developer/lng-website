// models/configCostCenter.model.js
const mongoose = require('mongoose');

const configCostCenterSchema = new mongoose.Schema({
    platform: { type: String, required: true, enum: ['Amazon', 'Ebay', 'Etsy', 'Facebook', 'Shopbase', 'Shopify', 'Tiktok', 'Woocommerce'], default: "Amazon" },

    // Mã cấu hình hiển thị trên bảng (unique)
    config_code: { type: String, required: true, trim: true, unique: true, index: true },

    // Các key customize (string để bạn map qua FE hoặc service khác)
    customize_size_key: { type: String, default: '' },
    customize_color_key: { type: String, default: '' },
    customize_product_type_key: { type: String, default: '' },
    customize_product_type_size_key: { type: String, default: '' },
    customize_product_type_color_key: { type: String, default: '' },
    combination_product_type_key: { type: String, default: '' },

    // Vị trí xuất hiện (cột “Size Position”, “Color Position”)
    size_position: { type: Number, default: 0, min: 0 },
    color_position: { type: Number, default: 0, min: 0 },

    // Map với platform & người bán
    product_type_from_platform: { type: String, default: '' }, // ví dụ: "LS1307 Sport-Tek Ladies' Replica"
    country: { type: String, required: true, default: 'United States' },

    // Product hiển thị cho seller (cho phép ref hoặc text)
    product_for_seller: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductTypeGroup' },

    default_color: { type: String, default: '' },

    is_set: { type: Boolean, default: false },
    is_pack: { type: Boolean, default: false },

    // Trạng thái / bật tắt trên bảng
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true },

    // Nhật ký thay đổi tối thiểu
    history: [{
        action: String,            // create | update | toggle | delete
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        diff: mongoose.Schema.Types.Mixed
    }],

    // Soft delete
    is_deleted: { type: Boolean, default: false, index: true }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

configCostCenterSchema.index({ platform: 1, status: 1, is_deleted: 1 });
configCostCenterSchema.index({ config_code: 1 }, { unique: true });

module.exports = mongoose.model('ConfigCostCenter', configCostCenterSchema);