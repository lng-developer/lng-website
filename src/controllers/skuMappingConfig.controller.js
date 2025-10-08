const db = require("../models");
const SkuMappingConfig = db.SkuMappingConfig;

exports.createConfig = async (req, res) => {
    try {
        const cfg = await SkuMappingConfig.create({
            ...req.body,
            created_by: req.user?._id || null,
            updated_by: req.user?._id || null,
        });
        res.json(cfg);
    } catch (e) { res.status(500).json({ message: 'Create config failed', error: e.message }); }
};

exports.updateConfig = async (req, res) => {
    try {
        const { id } = req.params;
        const cfg = await SkuMappingConfig.findByIdAndUpdate(id, { ...req.body, updated_by: req.user?._id || null }, { new: true });
        if (!cfg) return res.status(404).json({ message: 'Config not found' });
        res.json(cfg);
    } catch (e) { res.status(500).json({ message: 'Update config failed', error: e.message }); }
};

exports.listConfigs = async (req, res) => {
    try {
        const { active, q } = req.query;
        const filter = {};
        if (active === 'true') filter.is_active = true;
        if (q) filter.name = new RegExp(q, 'i');
        const items = await SkuMappingConfig.find(filter).sort({ is_active: -1, priority: 1, updatedAt: -1 }).lean();
        res.json(items);
    } catch (e) { res.status(500).json({ message: 'List failed', error: e.message }); }
};

exports.toggleActive = async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        const cfg = await SkuMappingConfig.findByIdAndUpdate(id, { is_active: !!is_active, updated_by: req.user?._id || null }, { new: true });
        if (!cfg) return res.status(404).json({ message: 'Config not found' });
        res.json(cfg);
    } catch (e) { res.status(500).json({ message: 'Toggle failed', error: e.message }); }
};

/** Lấy danh sách config “đang hiệu lực” theo ngày/ưu tiên */
exports.getActiveConfigs = async (req, res) => {
    try {
        const now = new Date();
        const items = await SkuMappingConfig.find({
            is_active: true,
            $and: [
                { $or: [{ valid_from: null }, { valid_from: { $lte: now } }] },
                { $or: [{ valid_to: null }, { valid_to: { $gte: now } }] },
            ],
        })
            .sort({ priority: 1, updatedAt: -1 })
            .lean();

        res.json(items);
    } catch (e) {
        res.status(500).json({ message: 'Get active failed', error: e.message });
    }
};
