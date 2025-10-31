const db = require('../models');
const User = db.user
const PointLog = db.PointLog
/**
 * Cộng điểm từ 1 task. Idempotent theo (user_id, task_id).
 */
const PointMap = Object.freeze({
  EASY: 1,
  NORMAL: 2,
  HARD: 3,
  EXTREMELY: 4,
});

async function addPointsFromTask({ userId, taskId, difficulty, note = '' }) {
  if (!userId || !taskId) throw new Error('userId & taskId required');
  
  const points = PointMap[difficulty?.toUpperCase()] || PointMap.EASY;

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { 'wallet.balance': points } },
    { new: true, lean: true }
  );
  
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  let log;
  try {
    log = await PointLog.create({
      user_id: userId,
      task_id: taskId,
      points,
      note,
      balance_after: user.wallet?.balance ?? 0
    });
  } catch (err) {
    if (err.code === 11000) {
      await User.findByIdAndUpdate(
        userId,
        { $inc: { 'wallet.balance': -points } }
      );
      
      const existedLog = await PointLog.findOne({ 
        user_id: userId, 
        task_id: taskId 
      }).lean();
      
      return { 
        skipped: true, 
        reason: 'Points already awarded for this task',
        log: existedLog 
      };
    }
    throw err;
  }

  return { skipped: false, user, log };
}

module.exports = { addPointsFromTask };
