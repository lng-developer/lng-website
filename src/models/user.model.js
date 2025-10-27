const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    full_name: String,
    email: { type: String, required: true, unique: true },
    phone: String,
    role_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true },
    revokeAllBefore: { type: Date, default: new Date(0), index: true },
    employee_id: { type: String, required: true, unique: true },
    team_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('User', userSchema);
