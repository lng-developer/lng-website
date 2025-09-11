// src/utils/sku-migrate.util.js

// ✅ Helper: Map/PlainObject safe -> Plain object
function mapLikeToPlain(obj) {
    if (!obj) return {};
    if (typeof obj.toObject === 'function') return obj.toObject(); // Mongoose Map on doc
    if (obj instanceof Map) return Object.fromEntries(obj);        // Native Map
    if (typeof obj === 'object' && !Array.isArray(obj)) return obj; // Plain
    return {};
}

// ✅ Parse + transform
function applyRulesToSku(sku, rules) {
    if (!sku || typeof sku !== 'string') {
        return { ok: false, changed: false, next: sku };
    }

    const raw = sku.trim();
    const parts = raw.split('-');
    // dạng linh hoạt: EMP - ...middle... - DATE(DDMMYY|DDMM) - SEQ
    if (parts.length < 4) return { ok: false, changed: false, next: sku };

    let emp = parts[0];
    let seq = parts[parts.length - 1];
    let date = parts[parts.length - 2];
    let middle = parts.slice(1, -2);

    // DATE phải là 6 số (DDMMYY) hoặc 4 số (DDMM)
    if (!/^\d{6}$/.test(date) && !/^\d{4}$/.test(date)) {
        return { ok: false, changed: false, next: sku };
    }

    // employeeMap: case-insensitive (key chuẩn hoá UPPER)
    const empKey = emp.toUpperCase();
    const empMap = rules?.employeeMap ? mapLikeToPlain(rules.employeeMap) : {};
    if (empMap[empKey]) emp = empMap[empKey];

    // upperProduct (default true)
    const shouldUpper = rules?.upperProduct !== false;
    if (shouldUpper) {
        middle = middle.map(t => String(t).toUpperCase());
    }

    // productMap
    const prodMap = rules?.productMap ? mapLikeToPlain(rules.productMap) : {};
    if (prodMap && typeof prodMap === 'object') {
        middle = middle.map(t => prodMap[t] || t);
    }

    // useToday -> thay date = hôm nay (DDMMYY)
    if (rules?.useToday) {
        const d = new Date();
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        date = `${dd}${mm}${yy}`;
    }

    // KHÔNG pad seq (theo yêu cầu mới)
    const next = [emp, ...middle, date, seq].join('-');
    return { ok: true, changed: next !== sku, next };
}

// ✅ Build rules từ config (dùng nội bộ & export)
function buildRulesFromConfig(cfg) {
    return {
        employeeMap: mapLikeToPlain(cfg?.employeeMap),
        productMap: mapLikeToPlain(cfg?.productMap),
        upperProduct: cfg?.options?.upperProduct !== false,
        useToday: !!cfg?.options?.useToday,
        // Không còn minSeqDigits (đã bỏ pad)
        restrictEmployee: Array.isArray(cfg?.options?.restrictEmployee)
            ? cfg.options.restrictEmployee
            : [],
    };
}

module.exports = {
    mapLikeToPlain,
    applyRulesToSku,
    buildRulesFromConfig,
};
