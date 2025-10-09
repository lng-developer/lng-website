const mongoose = require('mongoose');

const skuMappingEntrySchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    orderItemId: { type: String, required: true },

    oldSku: { type: String, required: true },
    newSku: { type: String, required: true },

    // liên kết config & rules
    config_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SkuMappingConfig', default: null },
    rulesSnapshot: { type: Object, default: null },

    source: { type: String, enum: ['import', 'bulk', 'manual'], default: 'import' },
    operator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    migratedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// chống log trùng theo (orderId, orderItemId, oldSku, newSku)
skuMappingEntrySchema.index({ orderId: 1, orderItemId: 1, oldSku: 1, newSku: 1 }, { unique: true });
// truy vấn nhanh
skuMappingEntrySchema.index({ config_id: 1, migratedAt: -1 });
skuMappingEntrySchema.index({ orderId: 1, migratedAt: -1 });

module.exports = mongoose.model('SkuMappingEntry', skuMappingEntrySchema);
