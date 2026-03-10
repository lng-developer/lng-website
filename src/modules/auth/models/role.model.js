const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    description: String,
}, { timestamps: { createdAt: 'created_at' } });

module.exports = mongoose.models.Role || mongoose.model('Role', roleSchema);

