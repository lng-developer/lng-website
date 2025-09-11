// src/models/SkuMappingConfig.js
const mongoose = require('mongoose');

const skuMappingConfigSchema = new mongoose.Schema({
    name: { type: String, required: true },                 // Tên cấu hình
    description: { type: String, default: '' },

    // Rules
    employeeMap: { type: Map, of: String, default: {} },     // { OLD: NEW }
    productMap: { type: Map, of: String, default: {} },     // { OLD: NEW } (áp sau khi upper nếu upperProduct=true)
    options: {
        upperProduct: { type: Boolean, default: true },
        useToday: { type: Boolean, default: false },
        minSeqDigits: { type: Number, default: null },
        restrictEmployee: { type: [String], default: [] },     // chỉ áp với các mã này (nếu có)
    },

    // Quản trị
    is_active: { type: Boolean, default: false },
    priority: { type: Number, default: 100 },                // số nhỏ = ưu tiên cao
    valid_from: { type: Date, default: null },
    valid_to: { type: Date, default: null },

    // Audit
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

skuMappingConfigSchema.index({ is_active: 1, priority: 1 });
skuMappingConfigSchema.index({ valid_from: 1, valid_to: 1 });

module.exports = mongoose.model('SkuMappingConfig', skuMappingConfigSchema);
