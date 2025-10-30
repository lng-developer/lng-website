const mongoose = require('mongoose');
const db = require('../models');
const User = db.user
const PointLog = db.PointLog
/**
 * Cộng điểm từ 1 task. Idempotent theo (user_id, task_id).
 */
async function addPointsFromTask({ userId, taskId, points, note }) {
    if (!userId || !taskId) throw new Error('userId & taskId required');
    if (!Number.isInteger(points) || points <= 0) throw new Error('points must be positive integer');

    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        // Nếu đã có log cho task này -> bỏ qua (không cộng 2 lần)
        const existed = await PointLog.findOne({ user_id: userId, task_id: taskId }).session(session);
        if (existed) {
            await session.abortTransaction();
            session.endSession();
            return { skipped: true, log: existed };
        }

        // Cộng điểm vào wallet
        const user = await User.findByIdAndUpdate(
            userId,
            { $inc: { 'wallet.balance': points } },
            { new: true, session }
        );
        if (!user) throw new Error('User not found');

        // Ghi log + snapshot balance_after
        const [log] = await PointLog.create([{
            user_id: userId,
            task_id: taskId,
            points,
            note,
            balance_after: user.wallet?.balance ?? 0
        }], { session });

        await session.commitTransaction();
        session.endSession();
        return { skipped: false, user, log };
    } catch (err) {
        await session.abortTransaction();
        session.endSession();

        // Trường hợp unique index nổ -> xem như đã cộng rồi, trả log cũ
        if (err?.code === 11000) {
            const log = await PointLog.findOne({ user_id: userId, task_id: taskId });
            return { skipped: true, log };
        }
        throw err;
    }
}

module.exports = { addPointsFromTask };
