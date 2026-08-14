const mongoose = require('mongoose');

const caseSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    description: String,
    blocksProduction: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at' } });

module.exports = mongoose.model('Case', caseSchema);
