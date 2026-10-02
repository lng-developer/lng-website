/**
 * Trả về plain object từ nhiều dạng input (mongoose doc, Map, object).
 */
function mapLikeToPlain(obj) {
    if (!obj) return {};
    if (typeof obj.toObject === 'function') return obj.toObject();
    if (obj instanceof Map) return Object.fromEntries(obj);
    if (typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return {};
}

/**
 * Chuẩn hóa key theo UPPERCASE để tra cứu case-insensitive.
 */
function toUpperKeyObject(obj) {
    const plain = mapLikeToPlain(obj);
    const out = {};
    for (const k of Object.keys(plain)) {
        out[String(k).toUpperCase()] = plain[k];
    }
    return out;
}

/**
 * Build rules từ config DB.
 * - exactMap   : map toàn bộ SKU cũ → SKU mới (ưu tiên tuyệt đối, so sánh đúng-hệt)
 * - employeeMap: map token đầu (mã nhân viên) → token đầu mới (case-insensitive)
 * - productMap : map các token sản phẩm ở giữa → token mới (case-insensitive)
 * - upperProduct: true => ép uppercase các token sản phẩm ở giữa trước khi map
 * - dateOptional: true => KHÔNG chèn/ép ngày; nếu SKU có ngày thì giữ, không có thì thôi
 * - restrictEmployee: chỉ xử lý nếu emp thuộc danh sách này (nếu danh sách không rỗng)
 */
function buildRulesFromConfig(cfg) {
    const opt = cfg?.options || {};
    // Ưu tiên options.dateOptional; nếu không có thì fallback: dateOptional = !useToday
    const dateOptional =
        typeof opt.dateOptional === 'boolean'
            ? opt.dateOptional
            : !opt.useToday;

    return {
        employeeMap: toUpperKeyObject(cfg?.employeeMap),
        productMap: toUpperKeyObject(cfg?.productMap),
        exactMap: mapLikeToPlain(cfg?.exactMap), // exact giữ nguyên hoa/thường
        upperProduct: opt?.upperProduct !== false,
        dateOptional,
        restrictEmployee: Array.isArray(opt?.restrictEmployee) ? opt.restrictEmployee : [],
    };
}

/**
 * Áp luật vào 1 SKU.
 * Trả về: { ok, changed, next, reason? }
 */
function applyRulesToSku(sku, rules) {
    if (!sku || typeof sku !== 'string') {
        return { ok: false, changed: false, next: sku, reason: 'empty' };
    }

    const raw = sku.trim();

    // 1) Ưu tiên exactMap: nếu khớp đúng-hệt SKU cũ → trả về SKU mới luôn
    const exact = mapLikeToPlain(rules?.exactMap);
    if (exact && Object.prototype.hasOwnProperty.call(exact, raw)) {
        const next = exact[raw];
        return { ok: true, changed: next !== raw, next };
    }

    // 2) Tách token theo format EMP - ...PRODUCT... - [DATE?] - SEQ
    const parts = raw.split('-');
    if (parts.length < 3) {
        return { ok: false, changed: false, next: sku, reason: 'too_few_tokens' };
    }

    // token đầu là employee code
    let emp = parts[0];
    const seq = parts[parts.length - 1];

    // áp chót có thể là ngày (yyyymm hoặc yyyy) — nhận 6 số hoặc 4 số
    const dateCandidate = parts[parts.length - 2];
    const hasDate = /^\d{6}$/.test(dateCandidate) || /^\d{4}$/.test(dateCandidate);

    // middle tokens là vùng sản phẩm
    let middle = hasDate ? parts.slice(1, -2) : parts.slice(1, -1);

    // 3) restrictEmployee: nếu có cấu hình, chỉ xử lý emp thuộc danh sách
    const restr = Array.isArray(rules?.restrictEmployee) ? rules.restrictEmployee : [];
    if (restr.length && !restr.includes(emp)) {
        return { ok: false, changed: false, next: sku, reason: 'emp_restricted' };
    }

    // 4) employeeMap: map token đầu (case-insensitive)
    const mappedEmp = rules?.employeeMap?.[emp.toUpperCase()];
    if (mappedEmp) {
        emp = mappedEmp;
    }

    // 5) Chuẩn hóa & map product (case-insensitive)
    if (rules?.upperProduct !== false) {
        middle = middle.map((t) => String(t).toUpperCase());
    }

    middle = middle.map((t) => {
        const k = String(t).toUpperCase();
        let mapped = (rules?.productMap || {})[k] || t;
        if (rules?.upperProduct !== false && typeof mapped === 'string') {
            mapped = mapped.toUpperCase(); // đồng nhất output
        }
        return mapped;
    });

    // 6) KHÔNG chèn ngày; nếu có day token thì giữ nguyên vị trí
    const next = hasDate
        ? [emp, ...middle, dateCandidate, seq].join('-')
        : [emp, ...middle, seq].join('-');

    return { ok: true, changed: next !== sku, next };
}

function getSkuMappingScopeQuery(scope) {
    const globalConfigs = [
        { scopes: { $exists: false } },
        { scopes: { $size: 0 } },
    ];

    return {
        $or: scope ? [...globalConfigs, { scopes: scope }] : globalConfigs,
    };
}

function resolveMappedSku(sku, configs = []) {
    for (const cfg of configs) {
        const result = applyRulesToSku(sku, buildRulesFromConfig(cfg));
        if (result.ok && result.changed) return result.next;
    }
    return sku;
}

module.exports = { mapLikeToPlain, buildRulesFromConfig, applyRulesToSku, getSkuMappingScopeQuery, resolveMappedSku };
