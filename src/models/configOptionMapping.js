// models/configOptionMapping.model.js
const mongoose = require('mongoose');

const configOptionMappingSchema = new mongoose.Schema({
  config_code: { type: String, required: true },     // NK, TSB, ...
  key: { type: String, enum: ['size', 'color'], required: true },
  match_type: { type: String, enum: ['equals', 'contains', 'regex', "regex_replace"], default: 'equals' },
  match_value: { type: String, required: true },     // ví dụ: 'Natural/Sand' hoặc 'Sand' hoặc '(?i)natural\/sand'
  mapped_value: { type: String, required: true },    // ví dụ: 'Natural'
  priority: { type: Number, default: 100 },          // số nhỏ ưu tiên trước
  active: { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('ConfigOptionMapping', configOptionMappingSchema);
