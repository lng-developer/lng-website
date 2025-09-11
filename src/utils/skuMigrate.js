// src/utils/sku-migrate.util.js
const SKU_RE = /^([A-Za-z0-9]+)-([A-Za-z0-9]+)-(\d{6})-([0-9]+)$/;

function parseSku(sku) {
    const m = String(sku || '').trim().match(SKU_RE);
    if (!m) return null;
    return { employee: m[1], product: m[2], dateStr: m[3], seqStr: m[4] };
}
function padLeft(numStr, minDigits) { return minDigits ? String(numStr).padStart(minDigits, '0') : numStr; }
// utils/sku-migrate.util.js
function applyRulesToSku(sku, rules) {
    if (!sku || typeof sku !== 'string') {
        return { ok: false, changed: false, next: sku };
    }

    const raw = sku.trim();
    const parts = raw.split('-');
    if (parts.length < 4) return { ok: false, changed: false, next: sku };

    let emp = parts[0];                         // ví dụ: J502
    let seq = parts[parts.length - 1];          // ví dụ: 5 (giữ nguyên, KHÔNG pad 05)
    let date = parts[parts.length - 2];          // ví dụ: 2907 hoặc 030725
    let middle = parts.slice(1, -2);               // ví dụ: ["TS1S","US"]

    // DATE: 6 số (DDMMYY) hoặc 4 số (DDMM)
    if (!/^\d{6}$/.test(date) && !/^\d{4}$/.test(date)) {
        return { ok: false, changed: false, next: sku };
    }

    // Employee map (case-insensitive)
    const empKey = emp.toUpperCase();
    if (rules?.employeeMap && rules.employeeMap[empKey]) {
        emp = rules.employeeMap[empKey];
    }

    // Upper-case product code nếu bật
    if (rules?.upperProduct !== false) {
        middle = middle.map(t => t.toUpperCase());
    }

    // ProductMap thay thế token nếu có
    if (rules?.productMap && typeof rules.productMap === 'object') {
        middle = middle.map(t => rules.productMap[t] || t);
    }

    // Date: đổi sang today nếu có option
    if (rules?.useToday) {
        const d = new Date();
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        date = `${dd}${mm}${yy}`; // DDMMYY
    }

    const next = [emp, ...middle, date, seq].join('-');
    return { ok: true, changed: next !== sku, next };
}

module.exports = { applyRulesToSku };


module.exports = { parseSku, applyRulesToSku };
