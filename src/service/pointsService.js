const db = require('../models');
const TaskType = require('../enumeration/taskType');
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

const ScaleAsinTypePoints = Object.freeze({
  "Normal": 1,
  "Custom Image": 1,
  "Outline": 2,
});

async function addPointsFromTask({ userId, taskId, type, difficulty, quantity = 1, note = '' }) {
  if (!userId || !taskId) throw new Error('userId & taskId required');
  
  let points;
  if (type === TaskType.ScaleTask) {
    points = ScaleAsinTypePoints[difficulty] ?? ScaleAsinTypePoints["Normal"];
  } else {
    points = PointMap[difficulty?.toUpperCase()] ?? PointMap.EASY;
  }
  points = points * quantity;

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
      type,
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
