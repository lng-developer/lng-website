// controllers/configOptionMapping.controller.js
const db = require('../models');
const mongoose = require('mongoose');
const ConfigOptionMapping = db.configOptionMapping; // ensure exported in models/index.js

const ALLOWED_KEYS = ['size', 'color'];
const ALLOWED_TYPES = ['equals', 'contains', 'regex', 'regex_replace'];

function norm(s) { return String(s || '').trim(); }

function validateOne(payload) {
    const errors = [];
    const out = {};

    out.config_code = norm(payload.config_code);
    out.key = norm(payload.key).toLowerCase();
    out.match_type = norm(payload.match_type || 'equals').toLowerCase();
    out.match_value = String(payload.match_value ?? '');
    out.mapped_value = String(payload.mapped_value ?? '');
    out.priority = Number.isFinite(payload.priority) ? Number(payload.priority) : 100;
    out.active = payload.active === false ? false : true;
    out.case_sensitive = !!payload.case_sensitive;
    out.regex_flags = payload.regex_flags || 'i';

    if (!out.config_code) errors.push('config_code is required');
    if (!ALLOWED_KEYS.includes(out.key)) errors.push(`key must be one of ${ALLOWED_KEYS.join(', ')}`);
    if (!ALLOWED_TYPES.includes(out.match_type)) errors.push(`match_type must be one of ${ALLOWED_TYPES.join(', ')}`);
    if (!out.match_value) errors.push('match_value is required');
    if (out.mapped_value === '') errors.push('mapped_value is required');

    // quick regex validation
    if ((out.match_type === 'regex' || out.match_type === 'regex_replace')) {
        try { new RegExp(out.match_value, out.regex_flags); } catch (e) {
            errors.push(`Invalid regex: ${e.message}`);
        }
    }

    return { ok: errors.length === 0, errors, data: out };
}

// ---------- CREATE (single or batch) ----------
const createMappings = async (req, res) => {
    try {
        const body = Array.isArray(req.body) ? req.body : [req.body];
        const docs = [];
        const errors = [];

        for (let i = 0; i < body.length; i++) {
            const v = validateOne(body[i]);
            if (!v.ok) {
                errors.push({ index: i, errors: v.errors });
                continue;
            }
            docs.push(v.data);
        }

        if (docs.length === 0) {
            return res.status(400).json({ message: 'No valid payload', errors });
        }

        const created = await ConfigOptionMapping.insertMany(docs);
        return res.json({
            message: 'Created',
            created_count: created.length,
            invalid_count: errors.length,
            errors,
            data: created
        });
    } catch (err) {
        return res.status(500).json({ message: 'Create failed', error: err.message });
    }
};

// ---------- UPSERT (by unique key: config_code+key+match_type+match_value) ----------
const upsertMapping = async (req, res) => {
    try {
        const v = validateOne(req.body);
        if (!v.ok) return res.status(400).json({ message: 'Invalid payload', errors: v.errors });

        const { config_code, key, match_type, match_value } = v.data;

        const doc = await ConfigOptionMapping.findOneAndUpdate(
            { config_code, key, match_type, match_value },
            { $set: v.data },
            { new: true, upsert: true }
        );
        return res.json({ message: 'Upserted', data: doc });
    } catch (err) {
        return res.status(500).json({ message: 'Upsert failed', error: err.message });
    }
};

// ---------- LIST + FILTER ----------
const listMappings = async (req, res) => {
    try {
        const {
            page = 1,
            perPage = 10,
            key,
            match_type,
            active,
            q, // giữ nguyên text search cũ
            search, // param mới
            sort // không set default ở đây nữa
        } = req.query;

        const match = {};
        if (key && ALLOWED_KEYS.includes(String(key).toLowerCase())) {
            match.key = String(key).toLowerCase();
        }
        if (match_type && ALLOWED_TYPES.includes(String(match_type).toLowerCase())) {
            match.match_type = String(match_type).toLowerCase();
        }
        if (active === 'true') match.active = true;
        if (active === 'false') match.active = false;

        // 🔹 Global search
        if (search) {
            match.$or = [
                { config_code: { $regex: search, $options: 'i' } }
            ];
        } else if (q) {
            match.$or = [
                { match_value: { $regex: q, $options: 'i' } },
                { mapped_value: { $regex: q, $options: 'i' } }
            ];
        }

        // Sort parser
        let sortObj = {};
        if (sort) {
            String(sort).split(',').forEach(pair => {
                const [k, dir] = pair.split(':').map(s => s.trim());
                if (!k) return;
                sortObj[k] = String(dir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
            });
        }

        if (Object.keys(sortObj).length === 0) {
            sortObj = { config_code: 1 };
        }

        const limit = String(perPage).toLowerCase() === 'all' ? 0 : Math.max(1, parseInt(perPage));
        const skip = limit ? (Math.max(1, parseInt(page)) - 1) * limit : 0;

        const [rows, total] = await Promise.all([
            ConfigOptionMapping.find(match).sort(sortObj).skip(skip).limit(limit),
            ConfigOptionMapping.countDocuments(match)
        ]);

        return res.json({
            data: rows,
            total,
            page: Number(page),
            perPage: limit || 'All',
            totalPages: limit ? Math.ceil(total / limit) : 1
        });
    } catch (err) {
        return res.status(500).json({ message: 'List failed', error: err.message });
    }
};


// ---------- GET ONE ----------
const getMappingById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid id' });

        const doc = await ConfigOptionMapping.findById(id);
        if (!doc) return res.status(404).json({ message: 'Not found' });
        return res.json(doc);
    } catch (err) {
        return res.status(500).json({ message: 'Get failed', error: err.message });
    }
};

// ---------- UPDATE ----------
const updateMappingById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid id' });

        const v = validateOne({
            ...req.body, // allow partial but validate fields if present
            config_code: req.body.config_code ?? 'dummy',
            key: req.body.key ?? 'size',
            match_type: req.body.match_type ?? 'equals',
            match_value: req.body.match_value ?? 'x',
            mapped_value: req.body.mapped_value ?? 'x'
        });

        // we validate only regex correctness if fields provided
        if (req.body.match_type && (req.body.match_type === 'regex' || req.body.match_type === 'regex_replace')) {
            try { new RegExp(req.body.match_value, req.body.regex_flags || 'i'); } catch (e) {
                return res.status(400).json({ message: `Invalid regex: ${e.message}` });
            }
        }

        const $set = {};
        [
            'config_code', 'key', 'match_type', 'match_value', 'mapped_value',
            'priority', 'active', 'regex_flags', 'case_sensitive'
        ].forEach(f => {
            if (req.body[f] !== undefined) $set[f] = req.body[f];
        });

        const doc = await ConfigOptionMapping.findByIdAndUpdate(id, { $set }, { new: true });
        if (!doc) return res.status(404).json({ message: 'Not found' });
        return res.json({ message: 'Updated', data: doc });
    } catch (err) {
        return res.status(500).json({ message: 'Update failed', error: err.message });
    }
};

// ---------- TOGGLE ACTIVE ----------
const toggleActive = async (req, res) => {
    try {
        const { id } = req.params;
        const { active } = req.body;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid id' });
        const doc = await ConfigOptionMapping.findByIdAndUpdate(id, { $set: { active: !!active } }, { new: true });
        if (!doc) return res.status(404).json({ message: 'Not found' });
        return res.json({ message: 'Toggled', data: doc });
    } catch (err) {
        return res.status(500).json({ message: 'Toggle failed', error: err.message });
    }
};

// ---------- DELETE (soft: active=false) ----------
const removeMapping = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid id' });
        const doc = await ConfigOptionMapping.findByIdAndUpdate(id, { $set: { active: false } }, { new: true });
        if (!doc) return res.status(404).json({ message: 'Not found' });
        return res.json({ message: 'Soft deleted (active=false)', data: doc });
    } catch (err) {
        return res.status(500).json({ message: 'Delete failed', error: err.message });
    }
};

// ---------- TEST RUN (áp dụng rule lên 1 giá trị) ----------
const testMapping = async (req, res) => {
    try {
        const { config_code, key, value, case_sensitive } = req.body;
        if (!config_code || !key) return res.status(400).json({ message: 'config_code and key are required' });

        const rules = await ConfigOptionMapping.find({
            config_code,
            key: String(key).toLowerCase(),
            active: { $ne: false }
        }).sort({ priority: 1, created_at: 1 }).lean();

        let val = String(value ?? '');
        const n = (x) => String(x || '').trim();
        const nl = (x) => String(x || '').toLowerCase().trim();

        for (const r of rules || []) {
            const mt = String(r.match_type || 'equals').toLowerCase();
            const flags = r.regex_flags || 'i';
            const cs = case_sensitive ?? !!r.case_sensitive; // allow override
            const mval = String(r.match_value ?? '');
            const mapped = String(r.mapped_value ?? '');

            try {
                if (mt === 'equals') {
                    const ok = cs ? n(val) === n(mval) : nl(val) === nl(mval);
                    if (ok) return res.json({ applied_rule_id: String(r._id), match_type: mt, before: value, after: mapped });
                }
                if (mt === 'contains') {
                    const ok = cs ? n(val).includes(n(mval)) : nl(val).includes(nl(mval));
                    if (ok) return res.json({ applied_rule_id: String(r._id), match_type: mt, before: value, after: mapped });
                }
                if (mt === 'regex') {
                    const re = new RegExp(mval, flags);
                    if (re.test(val)) return res.json({ applied_rule_id: String(r._id), match_type: mt, before: value, after: mapped });
                }
                if (mt === 'regex_replace') {
                    const re = new RegExp(mval, flags);
                    const replaced = val.replace(re, mapped);
                    if (replaced !== val) return res.json({ applied_rule_id: String(r._id), match_type: mt, before: value, after: replaced });
                }
            } catch (_) { /* ignore */ }
        }

        return res.json({ applied_rule_id: null, match_type: null, before: value, after: val, note: 'no rule matched' });
    } catch (err) {
        return res.status(500).json({ message: 'Test failed', error: err.message });
    }
};

module.exports = {
    createMappings,
    upsertMapping,
    listMappings,
    getMappingById,
    updateMappingById,
    toggleActive,
    removeMapping,
    testMapping
};
