const mongoose = require('mongoose');

const vendorCostCenterSchema = new mongoose.Schema({
    vendor_product: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProduct', required: true },
    vendor_size: { type: String, require: true },
    vendor_color: { type: String, require: true },
    standard_size: { type: String, require: true },
    standard_color: { type: String, require: true },
    sku: String,
    lng_code: String,
    base_cost: Number,
    dosmetic: {
        economy: { type: Number, require: true },
        additional: { type: Number, require: true }
    },
    international: {
        economy: { type: Number, require: true },
        additional: { type: Number, require: true }
    },
    // ✅ NEW: Shipping Priority
    priority: {
        economy: { type: Number, default: 0 },
        additional: { type: Number, default: 0 }
    },
    // ✅ Additional costs cho thêu và in
    additional_costs: {
        embroidery: { type: Number, default: 0 },
        two_sided_print: { type: Number, default: 0 },
        two_position_print: { type: Number, default: 0 }
    },
    product_type_design: String,
    history: [
        {
            updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            updated_at: { type: Date, default: Date.now }
        }
    ],
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('VendorCostCenter', vendorCostCenterSchema);

