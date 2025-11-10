// services/fulfillment/providers/grabink.js
const axios = require('axios');

/** =========================
 *  SHIPPING METHOD MAPPING
 *  ========================= */
function mapShippingMethod(shipping_type = 'Standard') {
    const t = String(shipping_type || '').toLowerCase();
    if (t.includes('overnight')) return 'overnight';
    if (t.includes('second')) return 'second_day';
    if (t.includes('expedited')) return 'Priority';
    if (t.includes('economy')) return 'economy';
    return 'standard';
}

/** =========================
 *  US STATE NORMALIZATION
 *  =========================
 * Chuẩn hoá State sang mã bưu điện 2 ký tự cho US & territories.
 * GRABINK_STRICT_STATE:
 *   - "false"  => không chặn, cố gắng auto-fix, nếu không được thì vẫn gửi nguyên trạng
 *   - (mặc định) khác "false" => chặn đơn nếu không map được state 2 ký tự
 */

const STRICT_STATE = String(process.env.GRABINK_STRICT_STATE || '').toLowerCase() !== 'false';

const STATE_ABBR = {
    // States
    'alabama': 'AL', 'al': 'AL',
    'alaska': 'AK', 'ak': 'AK',
    'american samoa': 'AS', 'as': 'AS',
    'arizona': 'AZ', 'az': 'AZ',
    'arkansas': 'AR', 'ar': 'AR',
    'california': 'CA', 'ca': 'CA',
    'colorado': 'CO', 'co': 'CO',
    'connecticut': 'CT', 'ct': 'CT',
    'delaware': 'DE', 'de': 'DE',
    'district of columbia': 'DC',
    'florida': 'FL', 'fl': 'FL',
    'georgia': 'GA', 'ga': 'GA',
    'guam': 'GU', 'gu': 'GU',
    'hawaii': 'HI', 'hi': 'HI',
    'idaho': 'ID', 'id': 'ID',
    'illinois': 'IL', 'il': 'IL',
    'indiana': 'IN', 'in': 'IN',
    'iowa': 'IA', 'ia': 'IA',
    'kansas': 'KS', 'ks': 'KS',
    'kentucky': 'KY', 'ky': 'KY',
    'louisiana': 'LA', 'la': 'LA',
    'maine': 'ME', 'me': 'ME',
    'maryland': 'MD', 'md': 'MD',
    'massachusetts': 'MA', 'ma': 'MA',
    'michigan': 'MI', 'mi': 'MI',
    'minnesota': 'MN', 'mn': 'MN',
    'mississippi': 'MS', 'ms': 'MS',
    'missouri': 'MO', 'mo': 'MO',
    'montana': 'MT', 'mt': 'MT',
    'nebraska': 'NE', 'ne': 'NE',
    'nevada': 'NV', 'nv': 'NV',
    'new hampshire': 'NH', 'nh': 'NH',
    'new jersey': 'NJ', 'nj': 'NJ',
    'new mexico': 'NM', 'nm': 'NM',
    'new york': 'NY', 'ny': 'NY',
    'north carolina': 'NC', 'nc': 'NC',
    'north dakota': 'ND', 'nd': 'ND',
    'northern mariana islands': 'MP', 'mp': 'MP',
    'ohio': 'OH', 'oh': 'OH',
    'oklahoma': 'OK', 'ok': 'OK',
    'oregon': 'OR', 'or': 'OR',
    'pennsylvania': 'PA', 'pa': 'PA',
    'puerto rico': 'PR', 'pr': 'PR',
    'rhode island': 'RI', 'ri': 'RI',
    'south carolina': 'SC', 'sc': 'SC',
    'south dakota': 'SD', 'sd': 'SD',
    'tennessee': 'TN', 'tn': 'TN',
    'texas': 'TX', 'tx': 'TX',
    'u.s. virgin islands': 'VI', 'us virgin islands': 'VI', 'virgin islands': 'VI', 'vi': 'VI',
    'utah': 'UT', 'ut': 'UT',
    'vermont': 'VT', 'vt': 'VT',
    'virginia': 'VA', 'va': 'VA',
    'washington': 'WA', 'wa': 'WA',
    'west virginia': 'WV', 'wv': 'WV',
    'wisconsin': 'WI', 'wi': 'WI',
    'wyoming': 'WY', 'wy': 'WY',
};

function normStr(x) {
    return String(x || '')
        .trim()
        .toLowerCase()
        .replace(/\./g, '')       // bỏ dấu chấm
        .replace(/\s+/g, ' ')     // gộp space
        .replace(/-/g, ' ');      // đổi gạch nối thành space để map tốt hơn
}

function normalizeUSState(input) {
    if (!input) return null;
    const s = normStr(input);
    // Nếu đã là 2 ký tự hợp lệ
    if (/^[A-Za-z]{2}$/.test(input)) {
        const up = input.toUpperCase();
        if (Object.values(STATE_ABBR).includes(up)) return up;
    }
    // Thử map theo từ khoá
    const hit = STATE_ABBR[s];
    if (hit) return hit;
    // Một số alias phổ biến
    const ALIASES = {
        'd c': 'DC',
        'washington d c': 'DC',
        'newyork': 'NY',
        'northcarolina': 'NC',
        'southcarolina': 'SC',
        'northdakota': 'ND',
        'southdakota': 'SD',
        'westvirginia': 'WV',
        'rhodeisland': 'RI',
        'newjersey': 'NJ',
        'newmexico': 'NM',
        'newhampshire': 'NH',
        'puertorico': 'PR',
        'usvi': 'VI',
    };
    if (ALIASES[s]) return ALIASES[s];

    return null;
}

function normalizeCountry(input) {
    const s = normStr(input);
    if (!s) return '';
    if (['us', 'usa', 'u s', 'u s a', 'united states', 'united states of america', 'america'].includes(s)) {
        return 'United States';
    }
    return input;
}

/** =========================
 *  PRINT FILES MAPPING
 *  ========================= */
function buildGrabinkPrintFiles(ff, item) {
    if (!ff) return [];

    // Map keys nội bộ -> keys Grabink
    const keyMap = {
        front: 'front',
        back: 'back',
        left_sleeve: 'sleeve_left',
        right_sleeve: 'sleeve_right',
        collar: 'chest_left', // thay đổi ở đây nếu phía Grabink yêu cầu khác
    };

    if (ff instanceof Map) {
        return Array.from(ff.entries())
            .filter(([, v]) => !!v)
            .map(([k, v]) => ({ key: keyMap[k] || String(k).toLowerCase(), url: String(v) }));
    }
    if (typeof ff === 'object' && !Array.isArray(ff)) {
        return Object.entries(ff)
            .filter(([, v]) => !!v)
            .map(([k, v]) => ({ key: keyMap[k] || String(k).toLowerCase(), url: String(v) }));
    }
    if (typeof ff === 'string') {
        return ff ? [{ key: 'front', url: ff }] : [];
    }
    return [];
}

/** =========================
 *  BUILD PAYLOAD (Grabink)
 *  ========================= */
function buildPayload(orderObj) {
    const completedItems = (orderObj.items || []).filter(i => i.scale_status === 'Complete');

    // Country/state normalize
    const rawCountry = orderObj.customer_infor?.country || '';
    const country = normalizeCountry(rawCountry);

    const rawState = orderObj.customer_infor?.state || '';
    const isUS = country === 'United States';
    const stateAbbr = isUS ? normalizeUSState(rawState) : (rawState || '');

    if (isUS && STRICT_STATE && !stateAbbr) {
        const e = new Error(
            `INVALID_STATE_ABBR: State phải ở dạng viết tắt 2 ký tự (ví dụ: TN, CA, LA, ...). Giá trị hiện tại: "${rawState}"`
        );
        e.code = 'INVALID_STATE_ABBR';
        e.details = {
            hint: 'Hãy dùng bảng U.S. state postal abbreviation và nhập đúng 2 ký tự.',
            state_examples: ['TN', 'CA', 'LA', 'NY', 'TX'],
        };
        throw e;
    }

    // (Tuỳ chọn) kiểm tra ZIP US cơ bản (5 hoặc 5-4)
    const rawZip = orderObj.customer_infor?.zip_code || '';
    if (isUS && rawZip && !/^\d{5}(-\d{4})?$/.test(String(rawZip))) {
        // Không chặn mặc định để tránh fail đơn cũ; nếu muốn chặn, thêm STRICT_ZIP tương tự.
        // console.warn(`[Grabink] ZIP không ở định dạng 5 hoặc 5-4: "${rawZip}"`);
    }

    return {
        api_key: process.env.GRABINK_API_KEY,
        line_items: completedItems.map(item => {
            const printFiles = [
                ...buildGrabinkPrintFiles(item.fulfillment_file, item),
                ...(item.svgFile ? [{ key: 'svg', url: item.svgFile }] : []),
            ];

            return {
                variant_id: null, // TODO: map từ VendorProduct nếu có
                sku: item.cost_breakdown?.matchedSku,
                product_name: item.cost_breakdown?.itemDisplayName || item.title,
                quantity: item.quantity,
                mockup: item.baseImage?.imageUrl || null,
                mockup_back: '',
                print_files: printFiles,
            };
        }),

        is_scan_label: false,
        order_status: 'new',
        ref_id: orderObj.orderId,
        shipping_label: null,
        shipping_method: mapShippingMethod(orderObj.shipping_type),

        address: {
            name: orderObj.customer_infor?.name || '',
            email: orderObj.customer_infor?.email || '',
            phone: orderObj.customer_infor?.phone_number || '',
            country, // đã normalize
            state: isUS ? (stateAbbr || rawState) : (rawState || ''),
            city: orderObj.customer_infor?.city || '',
            street1: orderObj.customer_infor?.address || '',
            street2: orderObj.customer_infor?.address_2 || null,
            zip: rawZip,
        },
    };
}

/** =========================
 *  SEND
 *  ========================= */
async function send(orderDoc) {
    const orderObj = orderDoc.toObject({ getters: false, virtuals: false });
    const payload = buildPayload(orderObj);

    if (!payload.line_items?.length) {
        const err = new Error('No completed items to send.');
        err.code = 'NO_LINE_ITEMS';
        throw err;
    }
    const anyHasPrint = payload.line_items.some(
        li => Array.isArray(li.print_files) && li.print_files.length > 0
    );
    if (!anyHasPrint) {
        const err = new Error('No print_files found for completed items.');
        err.code = 'NO_PRINT_FILES';
        throw err;
    }

    const endpoint = process.env.GRABINK_ENDPOINT || 'https://be.grabink.co/api/external/order';
    const headers = { 'Content-Type': 'application/json' };


    // 🟩 Thêm log payload ở đây
    console.log('=== [Grabink] Sending Payload ===');
    console.log(JSON.stringify(payload, null, 2));
    console.log('=== [Grabink] Endpoint:', endpoint, '===');
    const resp = await axios.post(endpoint, payload, { headers });

    if (resp.status >= 300) throw new Error(`Grabink responded with status ${resp.status}`);
    const externalId = resp.data?.id || resp.data?.orderId || null;

    return { data: resp.data, externalId };
}

module.exports = {
    key: 'grabink',
    canHandle: (orderDoc) => true, // Hoặc dựa theo order.vendor === 'grabink'
    send,
};
