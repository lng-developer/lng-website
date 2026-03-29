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
  leaderId: {
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User'
  },
  active: { type: Boolean, default: true }
}, {
  timestamps: true
});

teamSchema.index({ leaderId: 1 });

module.exports = mongoose.model('Team', teamSchema);