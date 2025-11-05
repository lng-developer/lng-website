const db = require('../models');
const TaskType = require('../enumeration/taskType');
const User = db.user;
const PointLog = db.PointLog;

/**
 * Điểm chuẩn theo độ khó (áp dụng cho PSD/Idea Task, ...).
 */
const PointMap = Object.freeze({
  EASY: 1,
  NORMAL: 2,
  HARD: 3,
  EXTREMELY: 4,
});

/**
 * Điểm theo asin_type cho ScaleTask.
 */
const ScaleAsinTypePoints = Object.freeze({
  "Normal": 1,
  "Custom Image": 1,
  "Outline": 2,
});

/**
 * Cộng điểm từ 1 task. Idempotent theo (user_id, task_id).
 */
async function addPointsFromTask({ userId, taskId, type, difficulty, quantity = 1, note = '' }) {
  if (!userId || !taskId) throw new Error('userId & taskId required');

  let points;
  if (type === TaskType.ScaleTask) {
    points = ScaleAsinTypePoints[difficulty] ?? ScaleAsinTypePoints["Normal"];
  } else {
    points = PointMap[String(difficulty || '').toUpperCase()] ?? PointMap.EASY;
  }
  points = points * quantity;

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { 'wallet.balance': points } },
    { new: true, lean: true }
  );
  if (!user) throw new Error(`User ${userId} not found`);

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
      // trùng (user_id, task_id) → rollback số dư
      await User.findByIdAndUpdate(userId, { $inc: { 'wallet.balance': -points } });
      const existedLog = await PointLog.findOne({ user_id: userId, task_id: taskId }).lean();
      return { skipped: true, reason: 'Points already awarded for this task', log: existedLog };
    }
    throw err;
  }

  return { skipped: false, user, log };
}

/**
 * Trừ điểm GENERIC cho mọi loại task (Scale/PSD/Idea...). Idempotent theo (user_id, task_id).
 * - Với ScaleTask: dùng ScaleAsinTypePoints theo asin_type
 * - Với PSD/Idea: dùng PointMap theo độ khó EASY/NORMAL/HARD/EXTREMELY
 */
async function addPenaltyFromTask({ userId, taskId, type, difficulty, quantity = 1, note = '' }) {
  if (!userId || !taskId) throw new Error('userId & taskId required');

  let unit;
  if (type === TaskType.ScaleTask) {
    unit = ScaleAsinTypePoints[difficulty] ?? ScaleAsinTypePoints["Normal"];
  } else {
    unit = PointMap[String(difficulty || '').toUpperCase()] ?? PointMap.EASY;
  }
  const points = -Math.abs(unit * quantity); // luôn âm

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { 'wallet.balance': points } },
    { new: true, lean: true }
  );
  if (!user) throw new Error(`User ${userId} not found`);

  try {
    const log = await PointLog.create({
      user_id: userId,
      task_id: taskId,
      points,
      note: note ? `[Penalty] ${note}` : '[Penalty]',
      type,
      balance_after: user.wallet?.balance ?? 0
    });
    return { skipped: false, user, log };
  } catch (err) {
    if (err.code === 11000) {
      // đã trừ trước đó → rollback $inc
      await User.findByIdAndUpdate(userId, { $inc: { 'wallet.balance': -points } });
      const existedLog = await PointLog.findOne({ user_id: userId, task_id: taskId }).lean();
      return { skipped: true, reason: 'Penalty already applied for this task', log: existedLog };
    }
    throw err;
  }
}

/**
 * Trừ điểm khi 1 item Scale bị QC reject (idempotent theo task_id riêng từng item).
 * taskId = `${orderId}:${orderItemId}:qc_reject`
 */
const ScaleRejectPenaltyPoints = Object.freeze({
  "Normal": 1,
  "Custom Image": 1,
  "Outline": 2,
});

async function addPenaltyForScaleReject({
  userId,
  orderId,
  orderItemId,
  asinType = 'Normal',
  note = 'QC Rejected'
}) {
  if (!userId || !orderId || !orderItemId) {
    throw new Error('userId, orderId, orderItemId required');
  }

  const raw = ScaleRejectPenaltyPoints[asinType] ?? ScaleRejectPenaltyPoints["Normal"];
  const points = -Math.abs(raw); // luôn âm
  const taskId = `${orderId}:${orderItemId}:QC-Reject`;

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { 'wallet.balance': points } },
    { new: true, lean: true }
  );
  if (!user) throw new Error(`User ${userId} not found`);

  let log;
  try {
    log = await PointLog.create({
      user_id: userId,
      task_id: taskId,
      points,
      note: `[Penalty] ${note} | asin_type=${asinType}`,
      type: TaskType.ScaleTask,
      balance_after: user.wallet?.balance ?? 0
    });
  } catch (err) {
    if (err.code === 11000) {
      // đã trừ trước đó cho item này → rollback lần $inc vừa rồi
      await User.findByIdAndUpdate(userId, { $inc: { 'wallet.balance': -points } });
      const existedLog = await PointLog.findOne({ user_id: userId, task_id: taskId }).lean();
      return { skipped: true, reason: 'Penalty already applied for this item reject', log: existedLog };
    }
    throw err;
  }

  return { skipped: false, user, log };
}

module.exports = {
  addPointsFromTask,
  addPenaltyFromTask,     // generic penalty cho PSD/Idea/... (và dùng được cho Scale nếu muốn)
  addPenaltyForScaleReject, // penalty chuyên biệt cho Scale reject theo orderItem
  PointMap,
  ScaleAsinTypePoints
};
