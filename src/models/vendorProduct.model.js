const mongoose = require('mongoose');

const vendorProductSchema = new mongoose.Schema({
    vendor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    image: String,
    product_id: String,
    product_name: String,
    //cost_center: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorCostCenter', required: true },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    product_type_design: String
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('VendorProduct', vendorProductSchema);
