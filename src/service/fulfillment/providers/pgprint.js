// services/fulfillment/providers/pgprint.js
// PGPrint API: POST https://app.pgprints.io/app/v1/orders/create
// Auth: X-PGPrints-Hmac-Sha256 + X-PGPrints-Store-Id
const axios = require('axios');
const crypto = require('crypto');

const PGPRINT_ENDPOINT = 'https://app.pgprints.io/app/v1/orders/create';

/* -------------------- Helpers -------------------- */
function splitName(full = '') {
    const name = String(full || '').trim();
    if (!name) return { firstName: '', lastName: '' };
    const parts = name.split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: '.' };
    const lastName = parts.pop();
    const firstName = parts.join(' ');
    return { firstName, lastName };
}

function safeStr(v) {
    return v === undefined || v === null ? '' : String(v);
}

/**
 * Tính HMAC-SHA256 signature cho request body.
 * PGPrint: HMAC-SHA256(secretKey, JSON.stringify(body)) → Base64
 * Ref: https://pgprints.gitbook.io/api/authentication
 */
function computeHmac(secretKey, bodyObject) {
    return crypto
        .createHmac('sha256', secretKey)
        .update(JSON.stringify(bodyObject))
        .digest('base64');
}

/* -------------------- Builders -------------------- */
/**
 * Build files array cho một line item từ fulfillment_file.
 * PGPrint format: [{ id, name, fileUrl: [url] }]
 */
function buildFiles(item) {
    const ff = item.fulfillment_file;
    if (!ff) {
        // Fallback sang baseImage
        const base = item?.baseImage?.imageUrl || '';
        if (!base) return [];
        return [{ id: 'main', name: 'Main', fileUrl: [String(base)] }];
    }

    const result = [];
    const getEntries = () => {
        if (ff instanceof Map) return [...ff.entries()];
        if (Array.isArray(ff)) return ff.map((x, i) => [x?.key || String(i), x?.url || x]);
        if (typeof ff === 'object') return Object.entries(ff);
        if (typeof ff === 'string') return [['front', ff]];
        return [];
    };

    const nameMap = {
        front: 'Main',
        back: 'Back',
        left_sleeve: 'Left Sleeve',
        right_sleeve: 'Right Sleeve',
        collar: 'Collar',
        neck: 'Neck Label',
    };

    getEntries().forEach(([key, url], idx) => {
        const urlStr = String(url || '').trim();
        if (!urlStr || !/^https?:\/\//i.test(urlStr)) return;
        result.push({
            id: safeStr(key) || `file_${idx}`,
            name: nameMap[key] || (safeStr(key) || 'Main'),
            fileUrl: [urlStr],
        });
    });

    if (result.length === 0) {
        const base = item?.baseImage?.imageUrl || '';
        if (base) result.push({ id: 'main', name: 'Main', fileUrl: [String(base)] });
    }

    return result;
}

/**
 * Build một line item theo schema PGPrint:
 * { name, sku, quantity, files, mockupImages }
 */
function buildLineItem(item) {
    const cost = item.cost_breakdown || {};
    const sku = safeStr(cost.matchedSku || item.sku || '');
    const name = safeStr(cost.itemDisplayName || item.title || item.name || sku);
    const quantity = Number(item.quantity || 1);
    const files = buildFiles(item);

    const mockupImages = [];
    const mockup = item?.baseImage?.imageUrl || item?.snapshotImage || '';
    if (mockup && /^https?:\/\//i.test(mockup)) {
        mockupImages.push(String(mockup));
    }

    return { name, sku, quantity, files, mockupImages };
}

/**
 * Build full payload theo schema PGPrint Create Order.
 * Chỉ gửi các item có scale_status === 'Complete'.
 */
function buildPayload(orderObj) {
    const customer = orderObj.customer_infor || {};
    const { firstName, lastName } = splitName(customer.name || '');
    const completedItems = (orderObj.items || []).filter(i => i.scale_status === 'Complete');

    const shippingAddress = {
        full_name: safeStr(customer.name || ''),
        first_name: safeStr(customer.firstName || customer.first_name || firstName),
        last_name: safeStr(customer.lastName || customer.last_name || lastName),
        address1: safeStr(customer.address || customer.shipping_address1 || ''),
        address2: safeStr(customer.address_2 || customer.shipping_address2 || ''),
        city: safeStr(customer.city || customer.shipping_city || ''),
        province: safeStr(customer.state || customer.province || customer.shipping_province_code || ''),
        zip: safeStr(customer.zip_code || customer.shipping_zip || ''),
        country: safeStr(customer.country || customer.shipping_country_code || 'US'),
        phone: safeStr(customer.phone_number || customer.shipping_phone || ''),
        email: safeStr(customer.email || ''),
        company: '',
    };

    // billing_address mặc định giống shipping nếu không có
    const billingAddress = orderObj.billing_address
        ? orderObj.billing_address
        : { ...shippingAddress };

    return {
        order_id: safeStr(orderObj.orderId || orderObj.order_id || ''),
        billing_address: billingAddress,
        shipping_address: shippingAddress,
        customer: {
            name: safeStr(customer.name || ''),
            first_name: safeStr(customer.firstName || customer.first_name || firstName),
            last_name: safeStr(customer.lastName || customer.last_name || lastName),
        },
        line_items: completedItems.map(buildLineItem),
        response_type: 'normal',
        production_note: safeStr(orderObj.note || orderObj.production_note || ''),
    };
}

/* -------------------- Preflight validation -------------------- */
function validatePayload(p) {
    const errors = [];
    if (!p.order_id) errors.push('Missing order_id');
    if (!Array.isArray(p.line_items) || p.line_items.length === 0) {
        errors.push('Missing line_items (no completed items found)');
    } else {
        p.line_items.forEach((it, idx) => {
            if (!it.sku) errors.push(`line_items[${idx}] missing sku`);
            if (!(Number(it.quantity) > 0)) errors.push(`line_items[${idx}].quantity must be > 0`);
            if (!Array.isArray(it.files) || it.files.length === 0) {
                errors.push(`line_items[${idx}] has no files (design images)`);
            }
        });
    }
    if (!p.shipping_address?.address1) errors.push('Missing shipping_address.address1');
    if (!p.shipping_address?.city) errors.push('Missing shipping_address.city');
    if (!p.shipping_address?.country) errors.push('Missing shipping_address.country');
    return { ok: errors.length === 0, errors };
}

/* -------------------------- Sender ------------------------- */
async function send(orderDoc) {
    const orderObj = orderDoc?.toObject
        ? orderDoc.toObject({ getters: false, virtuals: false })
        : orderDoc;

    const payload = buildPayload(orderObj);

    // Preflight
    const pre = validatePayload(payload);
    if (!pre.ok) {
        const err = new Error(`PGPrint payload validation failed: ${pre.errors.join('; ')}`);
        err.code = 'PGPRINT_PREVALIDATION_FAILED';
        err.details = pre.errors;
        throw err;
    }

    const storeId = process.env.PGPRINT_STORE_ID;
    const secret = process.env.PGPRINT_SECRET;
    if (!storeId || !secret) {
        const err = new Error('PGPrint: Missing PGPRINT_STORE_ID or PGPRINT_SECRET in environment.');
        err.code = 'PGPRINT_MISSING_CREDENTIALS';
        throw err;
    }

    // Ký trực tiếp trên object payload (docs: JSON.stringify inside hmac function)
    const hmac = computeHmac(secret, payload);

    const headers = {
        'Content-Type': 'application/json',
        'X-PGPrints-Hmac-Sha256': hmac,
        'X-PGPrints-Store-Id': storeId,
    };

    const endpoint = process.env.PGPRINT_ENDPOINT || PGPRINT_ENDPOINT;
    console.log('[PGPRINT] Create order endpoint:', endpoint);
    console.log('[PGPRINT] Sending payload:', JSON.stringify(payload, null, 2));

    let body;
    try {
        const resp = await axios.post(endpoint, payload, { headers });
        body = resp?.data;
    } catch (e) {
        const data = e?.response?.data;
        const status = e?.response?.status;
        const msg = data?.message || data?.error || String(e.message);
        const errOut = new Error(`PGPrint HTTP ${status}: ${msg}`);
        errOut.code = 'PGPRINT_HTTP_ERROR';
        errOut.vendorResponse = data;
        throw errOut;
    }

    if (!body || typeof body !== 'object') {
        const err = new Error('PGPrint: Empty or invalid JSON response');
        err.code = 'PGPRINT_INVALID_RESPONSE';
        throw err;
    }

    if (body.success === false) {
        const err = new Error(`PGPrint error: ${body.message || 'Unknown error'}`);
        err.code = 'PGPRINT_NON_SUCCESS';
        err.vendorResponse = body;
        throw err;
    }

    // External ID: lấy pgcOrderId ưu tiên, fallback id, orderId
    const d = body.data || {};
    const externalId = d.pgcOrderId || d.id || d.orderId || null;

    return { data: body, externalId };
}

module.exports = {
    key: 'pgprint',
    canHandle: (orderDoc) => String(orderDoc.vendor || '').toLowerCase() === 'pgprint',
    send,
};
