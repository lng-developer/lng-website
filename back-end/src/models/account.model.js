const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true, unique: true },
    password_hash: String,
    last_login: Date,
    refresh_token: { type: String }
}, { timestamps: { createdAt: 'created_at' } });

module.exports = mongoose.model('Account', accountSchema);
