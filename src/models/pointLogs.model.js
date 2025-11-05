const mongoose = require('mongoose');

const pointLogSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  task_id: { type: String, required: true },   // mã/id task nguồn điểm
  points:  { type: Number, required: true },   // luôn dương (chỉ cộng)
  note:    { type: String },                   // ghi chú ngắn (optional)
  type: {type: String , enum: ["PSD Task", "Idea Task", "Scale Task", "Fulfillment File"]},
  balance_after: { type: Number }              // snapshot sau khi cộng (optional)
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// 1 user + 1 task chỉ được cộng một lần
pointLogSchema.index({ user_id: 1, task_id: 1 }, { unique: true });
// phục vụ lọc theo thời gian
pointLogSchema.index({ user_id: 1, created_at: -1 });

module.exports = mongoose.model('PointLog', pointLogSchema);
