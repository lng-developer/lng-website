const mongoose = require('mongoose');

const caseSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    description: String,
}, { timestamps: { createdAt: 'created_at' } });

module.exports = mongoose.model('Case', caseSchema);
