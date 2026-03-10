// services/fulfillment/providers/merchfox.js
const axios = require('axios');

/** Mapping ship của MerchFox (có thể chỉnh nếu bạn có spec chính thức) */
function mapMethodShip(shipping_type = 'Standard') {
    const t = String(shipping_type || '').toLowerCase();
    if (process.env.MERCHFOX_METHODSHIP_DEFAULT) {
        const n = Number(process.env.MERCHFOX_METHODSHIP_DEFAULT);
        if (!Number.isNaN(n) && n > 0) return n;
    }
    if (t.includes('overnight')) return 3;
    if (t.includes('expedited')) return 2;
    if (t.includes('freeeconomy')) return 1;
    return 1; // Standard
}

function sanitizePhone(phone) {
    if (!phone) return '';
    return String(phone).replace(/\s*ext\..*$/i, '').trim();
}

function pickUrl(ff, key) {
    if (!ff) return '';
    if (ff instanceof Map) {
        const v = ff.get(key);
        return v ? String(v) : '';
    }
    if (typeof ff === 'object' && !Array.isArray(ff)) {
        const v = ff[key];
        return v ? String(v) : '';
    }
    if (typeof ff === 'string') {
        return key === 'front' ? ff : '';
    }
    return '';
}

function buildMerchFoxProduct(item) {
    const ff = item.fulfillment_file;
    return {
        quantity: item.quantity || 1,
        sku: item.cost_breakdown?.matchedSku || item.sku || '',
        areafront: pickUrl(ff, 'front'),
        areaback: pickUrl(ff, 'back'),
        lefthand: pickUrl(ff, 'left_sleeve'),
        righthand: pickUrl(ff, 'right_sleeve'),
        collar: pickUrl(ff, 'collar'),
        productname: item.cost_breakdown?.itemDisplayName || item.title || '',
        mockupfront: item.baseImage?.imageUrl || '',
        mockupback: '',
    };
}

function buildPayload(orderObj) {
    const completedItems = (orderObj.items || []).filter(i => i.scale_status === 'Complete');
    return {
        orderid: orderObj.orderId,
        firstname: (orderObj.customer_infor?.name || '').split(' ')?.[0] || '',
        lastname: (orderObj.customer_infor?.name || '').split(' ')?.slice(1).join(' ') || '',
        address1: orderObj.customer_infor?.address || '',
        address2: orderObj.customer_infor?.address_2 || '',
        city: orderObj.customer_infor?.city || '',
        state: orderObj.customer_infor?.state || '',
        country: orderObj.customer_infor?.country || '',
        zipcode: orderObj.customer_infor?.zip_code || '',
        email: orderObj.customer_infor?.email || '',
        phone: sanitizePhone(orderObj.customer_infor?.phone_number),
        methodship: mapMethodShip(orderObj.shipping_type),
        label: "",
        products: completedItems.map(buildMerchFoxProduct),
    };
}

async function send(orderDoc) {
    const orderObj = orderDoc.toObject({ getters: false, virtuals: false });
    const payload = buildPayload(orderObj);

    if (!payload.products?.length) {
        const err = new Error('No completed items to send.');
        err.code = 'NO_LINE_ITEMS';
        throw err;
    }

    const endpoint = process.env.MERCHFOX_ENDPOINT || 'https://api.mymerchfox.com/storeapi/v2/order/create';

    // Headers theo yêu cầu: tokenkey + secret
    const headers = {
        'Content-Type': 'application/json',
        tokenkey: process.env.MERCHFOX_TOKENKEY || 'my-tokenkey',
        secret: process.env.MERCHFOX_SECRET || 'my-secret',
    };

    const resp = await axios.post(endpoint, payload, { headers });

    // ---- Parse đúng schema MerchFox bạn cung cấp ----
    const body = resp?.data;
    if (!body || typeof body !== 'object') {
        throw new Error('MerchFox: Empty or invalid JSON response');
    }
    if (Number(body.code) !== 0) {
        const msg = body.message || 'Unknown error';
        const err = new Error(`MerchFox error: code=${body.code} message=${msg}`);
        err.code = 'MERCHFOX_NONZERO_CODE';
        err.vendorResponse = body;
        throw err;
    }
    const first = Array.isArray(body.data) ? body.data[0] : null;
    if (!first) {
        const err = new Error('MerchFox: data[] is empty');
        err.code = 'MERCHFOX_NO_DATA';
        err.vendorResponse = body;
        throw err;
    }

    // Ưu tiên mfid, fallback mfif, cuối cùng orderid
    const externalId = first.mfid || first.mfif || first.orderid || null;

    // Trả nguyên response để service lưu vào order.vendor_submissions['merchfox'].last_response
    return { data: body, externalId };
}

module.exports = {
    key: 'merchfox',
    // Bật điều kiện này nếu muốn tự động route theo order.vendor
    canHandle: (orderDoc) => String(orderDoc.vendor || '').toLowerCase() === 'merchfox',
    send,
};
