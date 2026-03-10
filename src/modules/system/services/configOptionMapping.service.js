// src/modules/system/services/configOptionMapping.service.js
const db = require('../../../models');
const mongoose = require('mongoose');
const ConfigOptionMapping = db.configOptionMapping;

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

    if ((out.match_type === 'regex' || out.match_type === 'regex_replace')) {
        try { new RegExp(out.match_value, out.regex_flags); } catch (e) {
            errors.push(`Invalid regex: ${e.message}`);
        }
    }

    return { ok: errors.length === 0, errors, data: out };
}

const createMappings = async (body) => {
    const items = Array.isArray(body) ? body : [body];
    const docs = [];
    const errors = [];

    for (let i = 0; i < items.length; i++) {
        const v = validateOne(items[i]);
        if (!v.ok) {
            errors.push({ index: i, errors: v.errors });
            continue;
        }
        docs.push(v.data);
    }

    if (docs.length === 0) {
        const error = new Error('No valid payload');
        error.status = 400;
        error.errors = errors;
        throw error;
    }

    const created = await ConfigOptionMapping.insertMany(docs);
    return {
        created_count: created.length,
        invalid_count: errors.length,
        errors,
        data: created
    };
};

const upsertMapping = async (body) => {
    const v = validateOne(body);
    if (!v.ok) {
        const error = new Error('Invalid payload');
        error.status = 400;
        error.errors = v.errors;
        throw error;
    }

    const { config_code, key, match_type, match_value } = v.data;

    return await ConfigOptionMapping.findOneAndUpdate(
        { config_code, key, match_type, match_value },
        { $set: v.data },
        { new: true, upsert: true }
    );
};

const listMappings = async (query) => {
    const {
        page = 1,
        perPage = 10,
        key,
        match_type,
        active,
        q,
        search,
        sort
    } = query;

    const match = {};
    if (key && ALLOWED_KEYS.includes(String(key).toLowerCase())) {
        match.key = String(key).toLowerCase();
    }
    if (match_type && ALLOWED_TYPES.includes(String(match_type).toLowerCase())) {
        match.match_type = String(match_type).toLowerCase();
    }
    if (active === 'true') match.active = true;
    if (active === 'false') match.active = false;

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

    return {
        data: rows,
        total,
        page: Number(page),
        perPage: limit || 'All',
        totalPages: limit ? Math.ceil(total / limit) : 1
    };
};

const getMappingById = async (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        const error = new Error('Invalid id');
        error.status = 400;
        throw error;
    }

    const doc = await ConfigOptionMapping.findById(id);
    if (!doc) {
        const error = new Error('Not found');
        error.status = 404;
        throw error;
    }
    return doc;
};

const updateMappingById = async (id, body) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        const error = new Error('Invalid id');
        error.status = 400;
        throw error;
    }

    if (body.match_type && (body.match_type === 'regex' || body.match_type === 'regex_replace')) {
        try { new RegExp(body.match_value, body.regex_flags || 'i'); } catch (e) {
            const error = new Error(`Invalid regex: ${e.message}`);
            error.status = 400;
            throw error;
        }
    }

    const $set = {};
    [
        'config_code', 'key', 'match_type', 'match_value', 'mapped_value',
        'priority', 'active', 'regex_flags', 'case_sensitive'
    ].forEach(f => {
        if (body[f] !== undefined) $set[f] = body[f];
    });

    const doc = await ConfigOptionMapping.findByIdAndUpdate(id, { $set }, { new: true });
    if (!doc) {
        const error = new Error('Not found');
        error.status = 404;
        throw error;
    }
    return doc;
};

const toggleActive = async (id, active) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        const error = new Error('Invalid id');
        error.status = 400;
        throw error;
    }
    const doc = await ConfigOptionMapping.findByIdAndUpdate(id, { $set: { active: !!active } }, { new: true });
    if (!doc) {
        const error = new Error('Not found');
        error.status = 404;
        throw error;
    }
    return doc;
};

const removeMapping = async (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        const error = new Error('Invalid id');
        error.status = 400;
        throw error;
    }
    const doc = await ConfigOptionMapping.findByIdAndUpdate(id, { $set: { active: false } }, { new: true });
    if (!doc) {
        const error = new Error('Not found');
        error.status = 404;
        throw error;
    }
    return doc;
};

const testMapping = async (body) => {
    const { config_code, key, value, case_sensitive } = body;
    if (!config_code || !key) {
        const error = new Error('config_code and key are required');
        error.status = 400;
        throw error;
    }

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
        const cs = case_sensitive ?? !!r.case_sensitive;
        const mval = String(r.match_value ?? '');
        const mapped = String(r.mapped_value ?? '');

        try {
            if (mt === 'equals') {
                const ok = cs ? n(val) === n(mval) : nl(val) === nl(mval);
                if (ok) return { applied_rule_id: String(r._id), match_type: mt, before: value, after: mapped };
            }
            if (mt === 'contains') {
                const ok = cs ? n(val).includes(n(mval)) : nl(val).includes(nl(mval));
                if (ok) return { applied_rule_id: String(r._id), match_type: mt, before: value, after: mapped };
            }
            if (mt === 'regex') {
                const re = new RegExp(mval, flags);
                if (re.test(val)) return { applied_rule_id: String(r._id), match_type: mt, before: value, after: mapped };
            }
            if (mt === 'regex_replace') {
                const re = new RegExp(mval, flags);
                const replaced = val.replace(re, mapped);
                if (replaced !== val) return { applied_rule_id: String(r._id), match_type: mt, before: value, after: replaced };
            }
        } catch (_) { /* ignore */ }
    }

    return { applied_rule_id: null, match_type: null, before: value, after: val, note: 'no rule matched' };
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

