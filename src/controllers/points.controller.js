const mongoose = require('mongoose');
const db = require('../models');
const User = db.user
const PointLog = db.PointLog
const { addPointsFromTask } = require('../service/pointsService');

// helper mềm dẻo: tự xác định admin theo nhiều cách (tùy hệ thống của bạn)
function isAdmin(user) {
    return user?.role_name === 'Admin'
        || user?.is_admin === true
        || (process.env.ADMIN_ROLE_ID && String(user?.role_id) === String(process.env.ADMIN_ROLE_ID));
}

function canReadUser(user, targetUserId) {
    return isAdmin(user) || String(user?._id) === String(targetUserId);
}

// POST /points/award
async function award(req, res) {
    try {
        const { userId, taskId, points, note } = req.body;
        const result = await addPointsFromTask({
            userId, taskId, points: parseInt(points, 1), note
        });
        res.json({ success: true, data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
}

// GET /points/:userId/balance
async function getBalance(req, res) {
    const { userId } = req.params;
    const { includeLogs = 'false', limit = 50, skip = 0 } = req.query;

    const user = await User.findById(userId).select('wallet.balance');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Mặc định chỉ trả balance
    const payload = { success: true, balance: user.wallet?.balance ?? 0 };

    // Nếu muốn kèm log cụ thể, bật includeLogs=true
    if (String(includeLogs).toLowerCase() === 'true') {
        const logs = await PointLog.find({ user_id: userId })
            .sort({ created_at: -1, _id: -1 })
            .skip(Number(skip))
            .limit(Number(limit));

        payload.logs = logs; // ✅ log cụ thể
        payload.meta = { limit: Number(limit), skip: Number(skip) };
    }

    return res.json(payload);
}

// GET /points/:userId/by-day?date=YYYY-MM-DD&tz=Asia/Bangkok
async function getByDay(req, res) {
    try {
        const { userId } = req.params;
        const { date, tz = 'Asia/Bangkok' } = req.query;
        if (!date) return res.status(400).json({ success: false, message: 'date (YYYY-MM-DD) required' });

        const pipeline = [
            { $match: { user_id: new mongoose.Types.ObjectId(userId) } },
            // Chuẩn hoá ra chuỗi ngày theo tz (ví dụ "2025-10-30")
            { $addFields: { dayStr: { $dateToString: { date: '$created_at', format: '%Y-%m-%d', timezone: tz } } } },
            { $match: { dayStr: date } },
            {
                $facet: {
                    total: [{ $group: { _id: null, points: { $sum: '$points' }, count: { $sum: 1 } } }],
                    logs: [{ $sort: { created_at: -1, _id: -1 } }]
                }
            }
        ];

        const result = await PointLog.aggregate(pipeline);
        const total = result?.[0]?.total?.[0]?.points || 0;
        const logs = result?.[0]?.logs || [];

        res.json({ success: true, date, tz, totalPointsInDay: total, logs });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
}

// GET /points/:userId/range?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Asia/Bangkok
async function getRange(req, res) {
    try {
        const { userId } = req.params;
        const { from, to, tz = 'Asia/Bangkok' } = req.query;
        if (!from || !to) return res.status(400).json({ success: false, message: 'Cần truyền from và to (YYYY-MM-DD)' });
        const pipeline = [
            { $match: { user_id: new mongoose.Types.ObjectId(userId) } },
            { $addFields: { dayStr: { $dateToString: { date: '$created_at', format: '%Y-%m-%d', timezone: tz } } } },
            { $match: { dayStr: { $gte: from, $lte: to } } }, // so sánh chuỗi ISO ngày => chuẩn & inclusive
            {
                $facet: {
                    summary: [{ $group: { _id: null, totalPoints: { $sum: '$points' }, count: { $sum: 1 } } }],
                    logs: [{ $sort: { created_at: -1, _id: -1 } }]
                }
            }
        ];

        const result = await PointLog.aggregate(pipeline);
        const total = result?.[0]?.summary?.[0]?.totalPoints || 0;
        const logs = result?.[0]?.logs || [];

        res.json({ success: true, range: { from, to, tz }, totalPointsInRange: total, logs });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
}

// GET /points/:userId/logs?limit=50&skip=0
async function getLogs(req, res) {
    const { userId } = req.params;
    const { limit = 50, skip = 0 } = req.query;
    const logs = await PointLog.find({ user_id: userId })
        .sort({ created_at: -1, _id: -1 })
        .skip(Number(skip))
        .limit(Number(limit));

    res.json({ success: true, logs });
}

async function getAllWithLogs(req, res) {
    try {
        const {
            from,                 // YYYY-MM-DD (optional)
            to,                   // YYYY-MM-DD (optional)
            tz = 'Asia/Bangkok',
            logsLimit = 20,       // số log tối đa mỗi user
            skip = 0,             // phân trang user
            limit = 50,           // phân trang user
            sort = '-range'       // sắp xếp: balance|-balance|range|-range|name
        } = req.query;

        // bộ lọc ngày cho lookup pipeline (dựa trên so sánh chuỗi yyyy-mm-dd)
        const dayMatch = {};
        if (from) dayMatch.$gte = from;
        if (to) dayMatch.$lte = to;

        // map sort
        const sortStage = (() => {
            switch (sort) {
                case 'balance': return { 'wallet.balance': 1, full_name: 1 };
                case '-balance': return { 'wallet.balance': -1, full_name: 1 };
                case 'range': return { totalPointsInRange: 1, full_name: 1 };
                case '-range': return { totalPointsInRange: -1, full_name: 1 };
                case 'name': return { full_name: 1 };
                default: return { totalPointsInRange: -1, full_name: 1 };
            }
        })();

        const pipeline = [
            // 1) Lấy user
            {
                $project: {
                    full_name: 1,
                    email: 1,
                    employee_id: 1,
                    team_id: 1,
                    role_id: 1,
                    wallet: { $ifNull: ['$wallet', { balance: 0 }] },
                    created_at: 1
                }
            },
            // 2) Join logs theo từng user, có lọc ngày + sort + limit per-user
            {
                $lookup: {
                    from: 'pointlogs', // tên collection do Mongoose suy ra
                    let: { uid: '$_id' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$user_id', '$$uid'] } } },
                        { $addFields: { dayStr: { $dateToString: { date: '$created_at', format: '%Y-%m-%d', timezone: tz } } } },
                        ...(Object.keys(dayMatch).length ? [{ $match: { dayStr: dayMatch } }] : []),
                        { $sort: { created_at: -1, _id: -1 } },
                        { $limit: Number(logsLimit) }
                    ],
                    as: 'logs'
                }
            },
            // 3) Tổng điểm trong khoảng ngày cho từng user
            {
                $addFields: {
                    totalPointsInRange: {
                        $ifNull: [{ $sum: '$logs.points' }, 0]
                    }
                }
            },
            // 4) Sắp xếp & phân trang user
            { $sort: sortStage },
            { $skip: Number(skip) },
            { $limit: Number(limit) }
        ];

        // Đếm tổng user để phục vụ phân trang
        const wrap = await User.aggregate([
            {
                $facet: {
                    data: pipeline,
                    totalUsers: [{ $count: 'count' }] // tổng số user toàn hệ thống (không filter theo ngày)
                }
            }
        ]);

        const data = wrap?.[0]?.data || [];
        const totalUsers = wrap?.[0]?.totalUsers?.[0]?.count || 0;

        // Chuẩn hoá output, đảm bảo luôn có balance number
        const rows = data.map(u => ({
            _id: u._id,
            full_name: u.full_name,
            email: u.email,
            employee_id: u.employee_id,
            team_id: u.team_id,
            role_id: u.role_id,
            balance: (u.wallet && typeof u.wallet.balance === 'number') ? u.wallet.balance : 0,
            totalPointsInRange: u.totalPointsInRange || 0,
            logs: u.logs || []
        }));

        return res.json({
            success: true,
            range: { from: from || null, to: to || null, tz },
            meta: {
                totalUsers,
                returned: rows.length,
                skip: Number(skip),
                limit: Number(limit),
                logsLimit: Number(logsLimit),
                sort
            },
            users: rows
        });
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }
}


module.exports = {
    award,
    getBalance,
    getByDay,
    getRange,
    getLogs,
    getAllWithLogs
};
