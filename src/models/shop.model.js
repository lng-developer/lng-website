const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema({
    store: { type: String, required: true },
    name: { type: String, required: true },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    team: [{ type: String }],
    userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    merchant: { type: String, required: true }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('Shop', shopSchema);