// src/utils/sku-migrate.util.js

function mapLikeToPlain(obj) {
    if (!obj) return {};
    if (typeof obj.toObject === 'function') return obj.toObject();
    if (obj instanceof Map) return Object.fromEntries(obj);
    if (typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return {};
}

function buildRulesFromConfig(cfg) {
    return {
        employeeMap: mapLikeToPlain(cfg?.employeeMap),
        productMap: mapLikeToPlain(cfg?.productMap),
        upperProduct: cfg?.options?.upperProduct !== false,
        // ❌ KHÔNG còn useToday
        // Cho phép SKU không có day token vẫn chạy (mặc định true để "xóa option chèn ngày")
        dateOptional: cfg?.options?.dateOptional !== false,
        restrictEmployee: Array.isArray(cfg?.options?.restrictEmployee)
            ? cfg.options.restrictEmployee
            : [],
    };
}

function applyRulesToSku(sku, rules) {
    if (!sku || typeof sku !== 'string') {
        return { ok: false, changed: false, next: sku, reason: 'empty' };
    }

    const raw = sku.trim();
    const parts = raw.split('-');
    if (parts.length < 3) {
        return { ok: false, changed: false, next: sku, reason: 'too_few_tokens' };
    }

    let emp = parts[0];
    const seq = parts[parts.length - 1];

    // phát hiện date token (áp chót)
    const dateCandidate = parts[parts.length - 2];
    const hasDate = /^\d{6}$/.test(dateCandidate) || /^\d{4}$/.test(dateCandidate);

    // middle tokens
    let middle = hasDate ? parts.slice(1, -2) : parts.slice(1, -1);

    // restrict employee (nếu cấu hình)
    const restr = rules?.restrictEmployee || [];
    if (restr.length && !restr.includes(emp)) {
        return { ok: false, changed: false, next: sku, reason: 'emp_restricted' };
    }

    // employee map (key case-insensitive)
    const empMap = mapLikeToPlain(rules?.employeeMap);
    const mappedEmp = empMap[emp.toUpperCase()];
    if (mappedEmp) emp = mappedEmp;

    // upper product
    if (rules?.upperProduct !== false) {
        middle = middle.map(t => String(t).toUpperCase());
    }

    // product map
    const prodMap = mapLikeToPlain(rules?.productMap);
    if (prodMap && typeof prodMap === 'object') {
        middle = middle.map(t => prodMap[t] || t);
    }

    // ❌ KHÔNG chèn ngày trong bất kỳ trường hợp nào
    const next = hasDate
        ? [emp, ...middle, dateCandidate, seq].join('-') // có day → giữ nguyên
        : [emp, ...middle, seq].join('-');               // không có day → giữ nguyên format

    return { ok: true, changed: next !== sku, next };
}

module.exports = { mapLikeToPlain, buildRulesFromConfig, applyRulesToSku };
