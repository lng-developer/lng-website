const axios = require('axios');

// --- helper: pick mockup image if cần log/debug hoặc fallback ---
function pickMockup(item) {
    return (
        item?.baseImage?.imageUrl ||
        item?.snapshotImage ||
        item?.image ||
        null
    );
}

// --- helper: resolve URL public cho asset nội bộ ---
function resolveAssetUrl(keyOrUrl) {
    if (!keyOrUrl) return '';
    if (/^https?:\/\//i.test(String(keyOrUrl))) return String(keyOrUrl);

    const base = process.env.ASSET_BASE_URL || '';
    return base
        ? `${base.replace(/\/+$/, '')}/${String(keyOrUrl).replace(/^\/+/, '')}`
        : '';
}

// --- helper: chọn items theo scale_status ---
function pickCompletedItems(orderObj, allowedStatuses) {
    const whitelist = (Array.isArray(allowedStatuses) && allowedStatuses.length)
        ? allowedStatuses.map(s => String(s).trim().toLowerCase())
        : ['complete'];

    return (orderObj.items || []).filter(i =>
        whitelist.includes(String(i.scale_status || '').toLowerCase())
    );
}

// --- helper: lấy value đầu tiên hợp lệ ---
function firstNonEmpty(...values) {
    for (const v of values) {
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
}

// --- helper: ép number an toàn ---
function toPositiveNumber(value, fallback = undefined) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

// --- helper: normalize uploadFiles keys theo label provider yêu cầu ---
function normalizeUploadFiles(raw = {}) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;

    for (const [key, value] of Object.entries(raw)) {
        if (!key || !value) continue;
        const url = resolveAssetUrl(value);
        if (!url) continue;
        out[String(key).trim()] = url;
    }
    return out;
}

const PRINT_POSITION_MAP = {
    front: 'FRO',
    'front design': 'FRO',
    design_front: 'FRO',

    back: 'BAC',
    'back design': 'BAC',
    design_back: 'BAC',

    left_sleeve: 'SLE',
    sleeve_left: 'SLE',
    'sleeve left': 'SLE',

    right_sleeve: 'SLV',
    sleeve_right: 'SLV',
    'sleeve right': 'SLV',

    mockup: 'MOC',
    'mockup back': 'MOK',
    mockup_back: 'MOK'
};

// --- UPDATED: build uploadFiles theo enum SS88 + luôn kèm mockup từ baseImage.imageUrl ---
function buildSS88UploadFiles(item = {}) {
    const out = {};
    const mockupUrl = resolveAssetUrl(
        item?.baseImage?.imageUrl ||
        item?.snapshotImage ||
        item?.image
    );

    // 1. Ưu tiên item.uploadFiles nếu đã có
    if (item?.uploadFiles && typeof item.uploadFiles === 'object') {
        for (const [key, value] of Object.entries(item.uploadFiles)) {
            if (!value) continue;

            const normalizedUrl = resolveAssetUrl(value);
            const normalizedKey = String(key).toLowerCase().trim();

            const mappedKey =
                PRINT_POSITION_MAP[normalizedKey] ||
                PRINT_POSITION_MAP[normalizedKey.replace(/\s+/g, '_')] ||
                null;

            if (mappedKey) {
                out[mappedKey] = normalizedUrl;
            }
        }

        // luôn kèm mockup nếu có
        if (mockupUrl && !out.MOC) {
            out.MOC = mockupUrl;
        }

        if (Object.keys(out).length) return out;
    }

    // 2. fallback từ fulfillment_file
    const ff = item?.fulfillment_file;
    if (!ff) {
        const svg = resolveAssetUrl(item?.svgFile);
        if (svg) out.FRO = svg;
        if (mockupUrl && !out.MOC) out.MOC = mockupUrl;
        return out;
    }

    const get = (obj, k) => obj?.get ? obj.get(k) : obj?.[k];
    let source = ff;

    if (ff instanceof Map) {
        source = Object.fromEntries(ff.entries());
    }

    if (typeof source === 'string') {
        const url = resolveAssetUrl(source);
        if (url) out.FRO = url;
        if (mockupUrl && !out.MOC) out.MOC = mockupUrl;
        return out;
    }

    if (typeof source !== 'object' || Array.isArray(source)) {
        if (mockupUrl) out.MOC = mockupUrl;
        return out;
    }

    const mapping = [
        { keys: ['front', 'Front Design', 'design_front'], code: 'FRO' },
        { keys: ['back', 'Back Design', 'design_back'], code: 'BAC' },
        { keys: ['left_sleeve', 'sleeve_left'], code: 'SLE' },
        { keys: ['right_sleeve', 'sleeve_right'], code: 'SLV' },
        { keys: ['mockup'], code: 'MOC' },
        { keys: ['mockup_back'], code: 'MOK' },
    ];

    for (const m of mapping) {
        for (const key of m.keys) {
            const val = get(source, key);
            if (val) {
                out[m.code] = resolveAssetUrl(val);
                break;
            }
        }
    }

    // fallback cuối cho design
    if (!out.FRO) {
        const svg = resolveAssetUrl(item?.svgFile);
        if (svg) out.FRO = svg;
    }

    // luôn kèm mockup từ baseImage.imageUrl nếu có
    if (mockupUrl && !out.MOC) {
        out.MOC = mockupUrl;
    }

    return out;
}

// --- helper: build dimensions nếu đủ bộ length/width/height ---
function buildDimensions(item = {}) {
    const length = toPositiveNumber(firstNonEmpty(
        item?.dimensions?.length,
        item?.package_dimensions?.length,
        item?.cost_breakdown?.dimensions?.length
    ));

    const width = toPositiveNumber(firstNonEmpty(
        item?.dimensions?.width,
        item?.package_dimensions?.width,
        item?.cost_breakdown?.dimensions?.width
    ));

    const height = toPositiveNumber(firstNonEmpty(
        item?.dimensions?.height,
        item?.package_dimensions?.height,
        item?.cost_breakdown?.dimensions?.height
    ));

    if (length && width && height) {
        return { length, width, height };
    }
    return undefined;
}

// --- helper: build addon fees ---
function buildAddonFees(item = {}, options = {}) {
    if (Array.isArray(item?.addonFees) && item.addonFees.length) {
        return item.addonFees.map(String);
    }

    if (Array.isArray(item?.addon_fees) && item.addon_fees.length) {
        return item.addon_fees.map(String);
    }

    if (Array.isArray(options?.addonFees) && options.addonFees.length) {
        return options.addonFees.map(String);
    }

    const envAddonFees = (process.env.SS88_DEFAULT_ADDON_FEES || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    return envAddonFees.length ? envAddonFees : undefined;
}

// --- helper: build từng line item theo schema SS88 ---
function buildLineItem(item = {}, options = {}) {
    const sku = firstNonEmpty(
        item?.cost_breakdown?.matchedSku,
        item?.vendorVariantSku,
        item?.sku
    );

    const quantity = parseInt(firstNonEmpty(item?.quantity, 1), 10);
    // const weightGrams = toPositiveNumber(firstNonEmpty(
    //     item?.weightGrams,
    //     item?.weight_grams,
    //     item?.shipping_weight_grams,
    //     item?.cost_breakdown?.weightGrams,
    //     process.env.SS88_DEFAULT_WEIGHT_GRAMS
    // ));

    const weightGrams = 200;

    const value = toPositiveNumber(firstNonEmpty(
        item?.value,
        item?.declaredValue,
        item?.price,
        item?.cost_breakdown?.unit_price,
        item?.cost_breakdown?.base_cost_total_for_item_including_shipping,
        process.env.SS88_DEFAULT_ITEM_VALUE,

    ));

    const dimensions = buildDimensions(item);
    const uploadFiles = buildSS88UploadFiles(item);
    const addonFees = buildAddonFees(item, options);

    const line = {
        sku: sku ? String(sku) : '',
        quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
        weightGrams,
        value,
    };

    if (dimensions) line.dimensions = dimensions;
    if (item?.note) line.note = String(item.note);
    if (item?.referenceId || item?.reference_id || item?._id) {
        line.referenceId = String(firstNonEmpty(item.referenceId, item.reference_id, item._id));
    }
    if (Object.keys(uploadFiles).length) line.uploadFiles = uploadFiles;
    if (addonFees?.length) line.addonFees = addonFees;

    return line;
}

// --- helper: build shipping address ---
function buildShippingAddress(orderObj = {}) {
    const shipping = orderObj.customer_infor || orderObj.shippingAddress || {};

    return {
        name: String(firstNonEmpty(shipping.name, shipping.full_name, '') || ''),
        address1: String(firstNonEmpty(shipping.address1, shipping.address, shipping.address_1, '') || ''),
        address2: String(firstNonEmpty(shipping.address2, shipping.address_2, '') || ''),
        city: String(firstNonEmpty(shipping.city, '') || ''),
        state: String(firstNonEmpty(shipping.state, shipping.province, shipping.region, '') || ''),
        postalCode: String(firstNonEmpty(shipping.postalCode, shipping.zip_code, shipping.zipCode, '') || ''),
        country: String(firstNonEmpty(shipping.country, shipping.country_code, '') || '').toUpperCase(),
        phone: String(firstNonEmpty(shipping.phone, shipping.phone_number, '') || ''),
        email: String(firstNonEmpty(shipping.email, '') || ''),
    };
}

// --- helper: map shipping_type sang SS88 serviceCode ---
const SHIPPING_TYPE_MAP = {
    // Standard / free economy → Standard
    standard:      'Standard',
    freeeconomy:   'Standard',
    'free economy':'Standard',
    economy:       'Standard',
    secondday:     'Standard',
    // Expedited → Priority
    expedited:     'Standard',
    priority:      'Priority',
};

function mapShippingTypeToServiceCode(shippingType) {
    if (!shippingType) return '';
    const key = String(shippingType).toLowerCase().trim();
    return SHIPPING_TYPE_MAP[key] || shippingType;
}

// --- helper: build payload tổng ---
function buildPayload(orderObj, options = {}) {
    const envStatuses = (process.env.SS88_ALLOWED_STATUSES || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const allowedStatuses = options.allowedStatuses?.length
        ? options.allowedStatuses
        : envStatuses;

    const completedItems = pickCompletedItems(orderObj, allowedStatuses);
    const shippingAddress = buildShippingAddress(orderObj);

    const rawServiceCode = String(firstNonEmpty(
        options?.serviceCode,
        orderObj?.shipping_type,
        orderObj?.shipping_service_code,
    ) || '');
    const serviceCode = mapShippingTypeToServiceCode(rawServiceCode);

    const orderNumber = firstNonEmpty(
        options?.orderNumber,
        orderObj?.order_number,
        orderObj?.platform_order_id,
        orderObj?.orderId,
        orderObj?._id
    );

    const note = firstNonEmpty(
        options?.note,
        orderObj?.note,
        orderObj?.seller_note,
        orderObj?.internal_note
    );

    return {
        items: completedItems.map(item => buildLineItem(item, options)),
        shippingAddress,
        serviceCode,
        ...(note ? { note: String(note) } : {}),
        ...(orderNumber ? { orderNumber: String(orderNumber) } : {}),
    };
}

// --- helper: validate payload trước khi bắn ---
function validatePayload(payload) {
    if (!Array.isArray(payload.items) || !payload.items.length) {
        const err = new Error('No items matching allowed statuses to send.');
        err.code = 'NO_LINE_ITEMS';
        throw err;
    }

    const badItems = [];
    payload.items.forEach((item, index) => {
        const problems = [];

        if (!item.sku) problems.push('missing sku');
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) problems.push('invalid quantity');
        if (!toPositiveNumber(item.weightGrams)) problems.push('missing/invalid weightGrams');
        if (!toPositiveNumber(item.value)) problems.push('missing/invalid value');

        if (item.dimensions) {
            const { length, width, height } = item.dimensions;
            if (!toPositiveNumber(length) || !toPositiveNumber(width) || !toPositiveNumber(height)) {
                problems.push('invalid dimensions');
            }
        }

        if (problems.length) {
            badItems.push({
                index,
                sku: item.sku || null,
                problems,
            });
        }
    });

    if (badItems.length) {
        const err = new Error('Invalid line items for SS88 payload');
        err.code = 'INVALID_LINE_ITEMS';
        err.details = badItems;
        throw err;
    }

    const s = payload.shippingAddress || {};
    const missingAddressFields = ['name', 'address1', 'city', 'state', 'postalCode', 'country']
        .filter(k => !String(s[k] || '').trim());

    if (missingAddressFields.length) {
        const err = new Error(`Missing required shipping fields: ${missingAddressFields.join(', ')}`);
        err.code = 'INVALID_SHIPPING_ADDRESS';
        err.details = missingAddressFields;
        throw err;
    }

    if (!payload.serviceCode) {
        const err = new Error('Missing serviceCode for SS88.');
        err.code = 'MISSING_SERVICE_CODE';
        throw err;
    }
}

// --- helper: parse lỗi business từ provider ---
function assertSS88Accepted(resp) {
    const data = resp?.data ?? {};

    const success = typeof data.success === 'boolean' ? data.success : undefined;
    const status = String(data.status || data.code || '').toLowerCase();
    const message = String(data.message || data.error || '');

    const insufficientBalance =
        /insufficient\s*balance/i.test(message) ||
        /insufficient\s*balance/i.test(status);

    const looksBad =
        success === false ||
        ['error', 'failed', 'fail'].includes(status) ||
        insufficientBalance ||
        !!data.errors;

    if (looksBad) {
        const err = new Error(
            insufficientBalance
                ? `SS88 rejected order: ${message || 'Insufficient balance'}`
                : `SS88 rejected order: ${message || 'Unknown error'}`
        );
        err.code = insufficientBalance ? 'INSUFFICIENT_BALANCE' : 'VENDOR_REJECTED';
        err.vendor = 'ss88';
        err.response = data;
        throw err;
    }

    return data;
}

async function send(orderDoc, options = {}) {
    const orderObj =
        typeof orderDoc?.toObject === 'function'
            ? orderDoc.toObject({ getters: false, virtuals: false })
            : orderDoc;

    const payload = buildPayload(orderObj, options);
    console.log('SS88 Payload:', JSON.stringify(payload));

    validatePayload(payload);

    const baseURL =
        process.env.SS88_BASE_URL ||
        'https://mmoseller.com';
    const endpoint = `${baseURL.replace(/\/+$/, '')}/api/external/orders`;

    const apiKey =
        options?.apiKey ||
        process.env.SS88_API_KEY;

    if (!apiKey) {
        const err = new Error('Missing SS88_API_KEY in env.');
        err.code = 'NO_API_KEY';
        throw err;
    }

    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
    };

    const resp = await axios.post(endpoint, payload, { headers });

    if (resp.status >= 300) {
        const err = new Error(`SS88 responded with status ${resp.status}`);
        err.code = 'HTTP_ERROR';
        err.vendor = 'ss88';
        err.response = resp?.data;
        throw err;
    }

    const data = assertSS88Accepted(resp);

    const externalId =
        data?.id ||
        data?.orderId ||
        data?.order_id ||
        data?.data?.id ||
        data?.data?.orderId ||
        data?.data?.order_id ||
        null;

    return {
        vendorKey: 'ss88',
        alreadySent: false,
        response: data,
        externalId,
    };
}

module.exports = {
    key: 'ss88',
    canHandle: () => true,
    send,
    _helpers: {
        buildPayload,
        buildLineItem,
        buildShippingAddress,
        buildSS88UploadFiles,
        validatePayload,
        assertSS88Accepted,
        resolveAssetUrl,
        pickMockup,
    },
};