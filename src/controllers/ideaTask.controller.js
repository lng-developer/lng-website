const db = require('../models');
const IdeaTask = db.IdeaTask; // export trong models/index.js
const { uploadBufferToWasabi, getSignedUrlForKey } = require('../utils/wasabi');

const multer = require('multer');

/** Multer: chỉ nhận .psd, .psb, .zip */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
    fileFilter: (req, file, cb) => {
        const ok = /\.(psd|psb|zip)$/i.test(file.originalname);
        if (!ok) return cb(new Error('Only .psd, .psb, .zip are allowed'));
        cb(null, true);
    },
});

// ===== Helpers =====
const STAT_KEYS = [
    'New',
    'Assigned',
    'In Progress',
    'Uploaded',
    'QC Rejected',
    'QC Passed',
];

const normalizeStatus = (s) => {
    switch (String(s || '').trim()) {
        case 'Submitted': return 'Uploaded';
        case 'Approved': return 'QC Passed';
        case 'Rejected': return 'QC Rejected';
        default: return s || 'New';
    }
};

const hasRole = (roleOrArr, role) => {
    if (Array.isArray(roleOrArr)) return roleOrArr.some((r) => new RegExp(`^${role}$`, 'i').test(r));
    return new RegExp(`^${role}$`, 'i').test(roleOrArr || '');
};

const actor = (req) => ({
    userId: req?.user?.userId || '',
    name: req?.user?.full_name || req?.user?.name || '',
});

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
    const { status, difficulty, assignee, from, to, search, mine } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (difficulty) filter.difficulty = Number(difficulty);
    if (assignee) filter['assignedTo.userId'] = assignee;
    if (from && to) filter.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    if (search) filter.$text = { $search: search };

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
// GET LIST
// =========================
const getAllIdeaTasks = async (req, res) => {
    try {
        const {
            page = 1,
            perPage = 10,
            sort = "createdAt",
            order = "desc",
            select,
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
                .select(select ? select.replace(/\s+/g, "") : undefined)
                .populate("createdBy", "full_name email role") // chỉ lấy field cần
                .populate("assignedTo", "full_name email role")
                .lean(),
        ]);

        const totalPages = Math.max(1, Math.ceil(total / limit));
        const hasNext = p < totalPages;
        const hasPrev = p > 1;

        res.json({
            message: "OK",
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
// STATISTICS
// =========================
const getIdeaTaskStatistics = async (req, res) => {
    try {
        let filter = buildFilterFromQuery(req);

        const r = req.user?.role;
        const isAdmin = hasRole(r, 'Admin');
        const isDL = hasRole(r, 'Design Leader');
        const me = req.user?.userId || '';

        if (!isAdmin && !isDL) {
            filter = {
                ...filter,
                $or: [
                    { 'createdBy.userId': me },
                    { 'assignedTo.userId': me },
                ],
            };
        }

        const raw = await IdeaTask.aggregate([
            { $match: filter },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]);

        const result = { all: 0 };
        STAT_KEYS.forEach(k => { result[k] = 0; });

        raw.forEach(row => {
            const norm = normalizeStatus(row._id);
            if (STAT_KEYS.includes(norm)) {
                result[norm] += row.count;
                result.all += row.count;
            }
        });

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

// =========================
// CRUD
// =========================
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
        const { title, description, referenceLink, deadline, productType, image } = req.body;

        // validate bắt buộc
        if (!title || !description || !productType || !image) {
            return res.status(400).json({
                message: 'Missing required fields',
                required: ['title', 'description', 'productType', 'image'],
            });
        }

        const doc = await IdeaTask.create({
            title,
            description,
            referenceLink: referenceLink || '',
            deadline: deadline ? new Date(deadline) : undefined,
            createdBy: req.user.userId, // chỉ lưu ObjectId (đã đổi sang ref User)
            productType,
            image,
            status: 'New',
            history: [{ by: req.user.userId, action: 'created', meta: { productType, image } }],
        });

        // populate để trả về đầy đủ thông tin user
        await doc.populate('createdBy', 'full_name email role');
        await doc.populate('assignedTo', 'full_name email role');

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

        const { title, description, referenceLink, deadline, productType, image } = req.body;

        if (title !== undefined) task.title = title;
        if (description !== undefined) task.description = description;
        if (referenceLink !== undefined) task.referenceLink = referenceLink;
        if (deadline !== undefined) task.deadline = deadline ? new Date(deadline) : undefined;

        // mới thêm:
        if (productType !== undefined) task.productType = productType;
        if (image !== undefined) task.image = image;

        task.history.push({
            by: req.user.userId,
            action: 'update',
            meta: { productType, image },
        });

        await task.save();

        // populate khi trả về
        await task.populate('createdBy', 'full_name email role');
        await task.populate('assignedTo', 'full_name email role');

        res.json({ message: 'Updated', data: task });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const deleteIdeaTask = async (req, res) => {
    try {
        const deleted = await IdeaTask.findByIdAndDelete(req.params.id);
        if (!deleted) return res.status(404).json({ message: 'Not found' });
        res.json({ message: 'Deleted', deletedId: req.params.id });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

// =========================
// FLOW ACTIONS
// =========================
const assignIdeaTask = async (req, res) => {
    try {
        const { difficulty, assigneeUserId } = req.body;
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: "Not found" });

        if (difficulty !== undefined) task.difficulty = Number(difficulty);
        if (assigneeUserId) task.assignedTo = assigneeUserId; // chỉ lưu ObjectId

        task.status = "Assigned";
        task.history.push({
            by: req.user.userId,
            action: "assigned",
            meta: { difficulty: task.difficulty, assignedTo: assigneeUserId },
        });

        await task.save();
        res.json({ message: "Assigned", data: task });
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

            const url = await getSignedUrlForKey(key, 7 * 24 * 3600);
            task.psd = { key, url, uploadedAt: new Date(), uploadedBy: actor(req) };
            task.status = 'Uploaded';
            task.history.push({ by: actor(req), action: 'upload', meta: { key } });

            await task.save();
            res.json({ message: 'Uploaded', data: task });
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
    if (isAdmin || isDL) return true;
    if (isSeller && task?.createdBy?.userId === me) return true;
    return false;
}

const approveTask = async (req, res) => {
    try {
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Not found' });
        if (!canApproveOrReject(req, task)) return res.status(403).json({ message: 'Access denied' });

        task.status = 'QC Passed';
        task.history.push({ by: actor(req), action: 'approve' });
        await task.save();

        res.json({ message: 'QC Passed', data: task });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const rejectTask = async (req, res) => {
    try {
        const { reason } = req.body;
        const task = await IdeaTask.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Not found' });
        if (!canApproveOrReject(req, task)) return res.status(403).json({ message: 'Access denied' });

        const prevKey = task.psd?.key || '';
        task.psd = { key: '', url: '', uploadedAt: null, uploadedBy: { userId: '', name: '' } };

        task.status = 'QC Rejected';
        task.history.push({ by: actor(req), action: 'reject', meta: { reason, clearedKey: prevKey } });

        await task.save();
        res.json({ message: 'QC Rejected', data: task });
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
    getAllIdeaTasks,
    getIdeaTaskById,
    createIdeaTask,
    updateIdeaTask,
    deleteIdeaTask,
    assignIdeaTask,
    startWork,
    uploadPsd,
    approveTask,
    rejectTask,
    addComment,
    getIdeaTaskStatistics,
};
