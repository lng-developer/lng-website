const db = require('../models');
const IdeaTask = db.ideaTask; // đảm bảo đã export trong models/index.js: db.ideaTask = require('./ideaTask.model');
const { uploadBufferToWasabi, getSignedUrlForKey } = require('../utils/wasabi');

const multer = require('multer');

/** Multer cấu hình: chỉ nhận .psd, .psb, .zip */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
    fileFilter: (req, file, cb) => {
        const ok = /\.(psd|psb|zip)$/i.test(file.originalname);
        if (!ok) return cb(new Error('Only .psd, .psb, .zip are allowed'));
        cb(null, true);
    },
});

/** Helper: so khớp role (chuỗi hoặc mảng) */
const hasRole = (roleOrArr, role) => {
    if (Array.isArray(roleOrArr)) return roleOrArr.some((r) => new RegExp(`^${role}$`, 'i').test(r));
    return new RegExp(`^${role}$`, 'i').test(roleOrArr || '');
};

const actor = (req) => ({ userId: req?.user?.userId || '', name: req?.user?.full_name || req?.user?.name || '' });

const canView = (req, task) => {
    const r = req.user?.role;
    const isAdmin = hasRole(r, 'Admin');
    const isDL = hasRole(r, 'Design Leader');
    const isDesigner = hasRole(r, 'Designer');
    const me = req.user?.userId;

    if (isAdmin || isDL) return true;
    if (task.createdBy?.userId === me) return true;
    if (isDesigner && task.assignedTo?.userId === me) return true;
    return false;
};

const canEditIdeaBasics = (req, task) => {
    // sửa title/description/referenceLink/deadline nếu còn New và là người tạo, hoặc Admin/DL
    const r = req.user?.role;
    const isAdmin = hasRole(r, 'Admin');
    const isDL = hasRole(r, 'Design Leader');
    const me = req.user?.userId;
    if (isAdmin || isDL) return true;
    return task.status === 'New' && task.createdBy?.userId === me;
};

const buildIdeaPsdKey = (ideaId, filename) => {
    const safe = String(filename).replace(/[^\w\-.]+/g, '_');
    const ts = Date.now();
    return `idea_tasks/${ideaId}/${ts}__${safe}`;
};
function buildFilterFromQuery(req) {
    const {
        status,
        difficulty,
        assignee,
        from,
        to,
        search,
        mine, // "true": chỉ hiện task của tôi
    } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (difficulty) filter.difficulty = Number(difficulty);
    if (assignee) filter['assignedTo.userId'] = assignee;
    if (from && to) filter.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    if (search) filter.$text = { $search: search };

    // RBAC: DL/Admin xem tất; Designer/User: chỉ xem liên quan
    const r = req.user?.role;
    const isAdmin = hasRole(r, 'Admin');
    const isDL = hasRole(r, 'Design Leader');
    const isDesigner = hasRole(r, 'Designer');
    const me = req.user?.userId || '';

    if (!isAdmin && !isDL) {
        if (isDesigner) {
            filter.$or = [{ 'assignedTo.userId': me }];
        } else {
            filter.$or = [{ 'createdBy.userId': me }];
        }
    }

    if (mine === 'true' && me) {
        filter.$or = [
            ...(filter.$or || []),
            { 'createdBy.userId': me },
            { 'assignedTo.userId': me },
        ];
    }

    return filter;
}

// =========================
// GET LIST (phân trang + metadata)
// =========================
const getAllIdeaTasks = async (req, res) => {
    try {
        const {
            page = 1,
            perPage = 10,
            sort = 'createdAt',
            order = 'desc',
            select, // optional: "title,status,deadline"
        } = req.query;

        const filter = buildFilterFromQuery(req);
        const p = Math.max(1, Number(page));
        const limit = Math.max(1, Math.min(200, Number(perPage)));
        const skip = (p - 1) * limit;

        const [total, data] = await Promise.all([
            IdeaTask.countDocuments(filter),
            IdeaTask.find(filter)
                .sort({ [sort]: /asc/i.test(order) ? 1 : -1 })
                .skip(skip)
                .limit(limit)
                .select(select ? select.replace(/\s+/g, '') : undefined)
                .lean(),
        ]);

        const totalPages = Math.max(1, Math.ceil(total / limit));
        const hasNext = p < totalPages;
        const hasPrev = p > 1;

        res.json({
            message: 'OK',
            page: p,
            perPage: limit,
            total,
            totalPages,
            hasNext,
            hasPrev,
            data,
        });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

// =========================
// STATISTICS (theo trạng thái + bổ sung unassigned, difficulty)
// =========================
const getIdeaTaskStatistics = async (req, res) => {
    try {
        let filter = buildFilterFromQuery(req);

        const r = req.user?.role;
        const isAdmin = hasRole(r, 'Admin');
        const isDL = hasRole(r, 'Design Leader');
        const me = req.user?.userId || '';

        if (!isAdmin && !isDL) {
            // user thường / designer: chỉ xem task của chính mình
            filter = {
                ...filter,
                $or: [
                    { 'createdBy.userId': me },
                    { 'assignedTo.userId': me },
                ],
            };
        }

        const pipeline = [
            { $match: filter },
            {
                $facet: {
                    byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
                    assigned: [
                        {
                            $group: {
                                _id: { $cond: [{ $ifNull: ['$assignedTo.userId', false] }, 'assigned', 'unassigned'] },
                                count: { $sum: 1 },
                            },
                        },
                    ],
                    byDifficulty: [{ $group: { _id: '$difficulty', count: { $sum: 1 } } }],
                    total: [{ $count: 'total' }],
                },
            },
        ];

        const [agg] = await IdeaTask.aggregate(pipeline);

        const byStatus = {
            New: 0,
            Assigned: 0,
            'In Progress': 0,
            Submitted: 0,
            Approved: 0,
            Rejected: 0,
            Archived: 0,
            ...(agg.byStatus || []).reduce((acc, x) => ({ ...acc, [x._id]: x.count }), {}),
        };

        const assigned = { assigned: 0, unassigned: 0 };
        (agg.assigned || []).forEach((x) => { assigned[x._id] = x.count; });

        const byDifficulty = {};
        (agg.byDifficulty || []).forEach((x) => {
            if (x._id != null) byDifficulty[String(x._id)] = x.count;
        });

        const total = (agg.total && agg.total[0] && agg.total[0].total) || 0;

        res.json({
            message: 'OK',
            scope: isAdmin || isDL ? 'all' : 'mine',
            total,
            byStatus,
            assigned,
            byDifficulty,
        });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const getIdeaTaskById = async (req, res) => {
    try {
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Not found' });
        if (!canView(req, task)) return res.status(403).json({ message: 'Access denied' });
        res.json({ message: 'OK', data: task });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const createIdeaTask = async (req, res) => {
    try {
        const { title, description, referenceLink, deadline } = req.body;

        if (!title || !description) return res.status(400).json({ message: 'Missing required fields' });

        const user = actor(req);
        const doc = await IdeaTask.create({
            title,
            description,
            referenceLink: referenceLink || '',
            deadline: deadline ? new Date(deadline) : undefined,
            createdBy: user,
            status: 'New',
            history: [{ by: user, action: 'created' }],
        });

        res.json({ message: 'Created', data: doc });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const updateIdeaTask = async (req, res) => {
    try {
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Not found' });
        if (!canEditIdeaBasics(req, task)) return res.status(403).json({ message: 'Access denied' });

        const { title, description, referenceLink, deadline } = req.body;
        if (title !== undefined) task.title = title;
        if (description !== undefined) task.description = description;
        if (referenceLink !== undefined) task.referenceLink = referenceLink;
        if (deadline !== undefined) task.deadline = deadline ? new Date(deadline) : undefined;

        task.history.push({ by: actor(req), action: 'update' });
        await task.save();

        res.json({ message: 'Updated', data: task });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const deleteIdeaTask = async (req, res) => {
    try {
        // chỉ Admin/DL mới đi đến đây (đã chặn ở routes), nên không cần check thêm
        const deleted = await IdeaTask.findByIdAndDelete(req.params.id);
        if (!deleted) return res.status(404).json({ message: 'Not found' });
        res.json({ message: 'Deleted', deletedId: req.params.id });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

/* =========================
   FLOW ACTIONS
========================= */

const assignIdeaTask = async (req, res) => {
    try {
        const { difficulty, assigneeUserId, assigneeName } = req.body;
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Not found' });

        if (difficulty !== undefined) task.difficulty = Number(difficulty);
        if (assigneeUserId) task.assignedTo = { userId: assigneeUserId, name: assigneeName || '' };

        task.status = 'Assigned';
        task.history.push({
            by: actor(req),
            action: 'assigned',
            meta: { difficulty: task.difficulty, assignedTo: task.assignedTo },
        });

        await task.save();
        res.json({ message: 'Assigned', data: task });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const startWork = async (req, res) => {
    try {
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Not found' });

        const me = req.user?.userId || '';
        const r = req.user?.role;
        const isDesigner = hasRole(r, 'Designer');
        const isAdmin = hasRole(r, 'Admin');
        const isDL = hasRole(r, 'Design Leader');

        if (!(isAdmin || isDL || (isDesigner && task.assignedTo?.userId === me))) {
            return res.status(403).json({ message: 'Access denied' });
        }

        task.status = 'In Progress';
        task.history.push({ by: actor(req), action: 'start' });
        await task.save();
        res.json({ message: 'In Progress', data: task });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const uploadPsd = [
    upload.single('file'),
    async (req, res) => {
        try {
            const task = await IdeaTask.findById(req.params.id);
            if (!task) return res.status(404).json({ message: 'Not found' });

            const me = req.user?.userId || '';
            const r = req.user?.role;
            const isDesigner = hasRole(r, 'Designer');
            const isAdmin = hasRole(r, 'Admin');
            const isDL = hasRole(r, 'Design Leader');

            if (!(isAdmin || isDL || (isDesigner && task.assignedTo?.userId === me))) {
                return res.status(403).json({ message: 'Access denied' });
            }

            if (!req.file) return res.status(400).json({ message: 'Missing file' });

            const key = buildIdeaPsdKey(task._id, req.file.originalname);
            await uploadBufferToWasabi(req.file.buffer, {
                Key: key,
                ContentType: req.file.mimetype || 'application/octet-stream',
            });

            const url = await getSignedUrlForKey(key, 7 * 24 * 3600); // 7 ngày
            task.psd = {
                key,
                url,
                uploadedAt: new Date(),
                uploadedBy: actor(req),
            };
            task.status = 'Submitted';
            task.history.push({ by: actor(req), action: 'submit', meta: { key } });

            await task.save();
            res.json({ message: 'Submitted', data: task });
        } catch (error) {
            res.status(500).json({ error: { message: error.message } });
        }
    },
];
function canApproveOrReject(req, task) {
    const r = req.user?.role;
    const me = req.user?.userId || '';

    const isAdmin = hasRole(r, 'Admin');
    const isDL = hasRole(r, 'Design Leader');
    const isSeller = hasRole(r, 'Seller');

    // Admin/DL luôn được
    if (isAdmin || isDL) return true;

    // Seller chỉ được nếu là người tạo idea đó (seller chủ idea)
    if (isSeller && task?.createdBy?.userId && task.createdBy.userId === me) return true;

    return false;
}

// --- APPROVE ---
const approveTask = async (req, res) => {
    try {
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Not found' });

        if (!canApproveOrReject(req, task)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        task.status = 'Approved';
        task.history.push({ by: actor(req), action: 'approve' });
        await task.save();

        res.json({ message: 'Approved', data: task });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

// --- REJECT (xóa sạch thông tin PSD) ---
const rejectTask = async (req, res) => {
    try {
        const { reason } = req.body;
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Not found' });

        if (!canApproveOrReject(req, task)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Lưu lại key cũ để ghi lịch sử (và optional xóa file)
        const prevKey = task.psd?.key || '';

        // (Tuỳ chọn) nếu bạn có hàm xóa file trên Wasabi thì bật đoạn sau:
        // try {
        //   if (prevKey) await deleteObjectFromWasabi(prevKey);
        // } catch (e) {
        //   // Không chặn reject nếu xóa file thất bại; chỉ log vào history
        //   task.history.push({ by: actor(req), action: 'wasabi_delete_failed', meta: { key: prevKey, error: e?.message } });
        // }

        // XÓA HẾT THÔNG TIN PSD TRONG TASK
        task.psd = {
            key: '',
            url: '',
            uploadedAt: null,
            uploadedBy: { userId: '', name: '' },
        };

        task.status = 'Rejected';
        task.history.push({ by: actor(req), action: 'reject', meta: { reason, clearedKey: prevKey } });

        await task.save();

        res.json({ message: 'Rejected', data: task });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const addComment = async (req, res) => {
    try {
        const { text } = req.body;
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Not found' });
        if (!canView(req, task)) return res.status(403).json({ message: 'Access denied' });

        task.comments.push({ by: actor(req), text });
        task.history.push({ by: actor(req), action: 'comment' });
        await task.save();
        res.json({ message: 'Commented', data: task });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

module.exports = {
    // CRUD
    getAllIdeaTasks,
    getIdeaTaskById,
    createIdeaTask,
    updateIdeaTask,
    deleteIdeaTask,
    // Flow
    assignIdeaTask,
    startWork,
    uploadPsd,
    approveTask,
    rejectTask,
    addComment,
    getIdeaTaskStatistics
};
