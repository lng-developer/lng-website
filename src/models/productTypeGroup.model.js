const mongoose = require('mongoose');

const productTypeItemSchema = new mongoose.Schema({
    // Thứ tự thủ công của item trong group
    order: { type: Number, required: true },

    // Trỏ thẳng tới VendorProduct để sau lookup ra vendor, product_id, image...
    vendor_product: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProduct', required: true },

    // Cho phép override tên hiển thị (không bắt buộc giống VendorProduct.product_name)
    display_name: { type: String, required: true },

    // TRUE/FALSE như UI
    is_variant: { type: Boolean, default: false },

    // Active/Inactive như UI
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, { _id: true });

const productTypeGroupSchema = new mongoose.Schema({
    // Ví dụ: "Raglan Shirt" hoặc "Embroidered Body Suit / Middle (SwaddleAn)"
    name: { type: String, required: true, trim: true },

    // Thứ tự thủ công giữa các group (nếu cần sắp xếp cả group)
    order: { type: Number, default: 1, index: true },

    // Danh sách items
    items: [productTypeItemSchema],
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// Gợi ý index để query nhanh
productTypeGroupSchema.index({ name: 'text' });

module.exports = mongoose.model('ProductTypeGroup', productTypeGroupSchema);
