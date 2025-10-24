const mongoose = require('mongoose');

const teamSchema = mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },
  userIds: [{
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User'
  }],
  active: { type: Boolean, default: true }
}, {
  timestamps: true
});

// Virtual để lấy totalMembers
teamSchema.virtual('totalMembers').get(function() {
  return this.userIds ? this.userIds.length : 0;
});

// Ensure virtuals are included in JSON
teamSchema.set('toJSON', { virtuals: true });
teamSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Team', teamSchema);