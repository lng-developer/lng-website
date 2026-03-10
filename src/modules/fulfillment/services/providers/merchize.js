// Ở đầu file (nếu thiếu)
const axios = require('axios');

// --- NEW: mockup picker (ưu tiên baseImage, rồi snapshot, rồi image) ---
function pickMockup(item) {
    return (
        item?.baseImage?.imageUrl ||
        item?.snapshotImage ||
        item?.image ||
        null
    );
}

// --- NEW: build attributes cho Merchize ---
function buildAttributes(item = {}) {
    const attrs = [];

    // product (tên sản phẩm hiển thị)
    const productName =
        item?.cost_breakdown?.itemDisplayName ||
        item?.product_name ||
        item?.title ||
        item?.name ||
        'Custom Product';
    attrs.push({ name: 'product', option: String(productName) });

    // Color
    const color =
        item?.color ||
        item?.variant_color ||
        item?.attributes?.color ||
        item?.cost_breakdown?.colorValue;
    if (color) attrs.push({ name: 'Color', option: String(color) });

    // Size
    const size =
        item?.size ||
        item?.variant_size ||
        item?.attributes?.size ||
        item?.cost_breakdown?.sizeValue;
    if (size) attrs.push({ name: 'Size', option: String(size) });

    return attrs;
}
// --- NEW: helper để resolve URL public cho asset nội bộ ---
function resolveAssetUrl(keyOrUrl) {
    if (!keyOrUrl) return '';
    // Nếu đã là URL đầy đủ thì trả về luôn
    if (/^https?:\/\//i.test(keyOrUrl)) return keyOrUrl;

    // Tùy hạ tầng của bạn: Cloudinary/S3/Static
    // Ví dụ Cloudinary: CLOUDINARY_ASSET_BASE="https://res.cloudinary.com/<cloud>/raw/upload"
    const base = process.env.ASSET_BASE_URL || '';
    return base ? `${base.replace(/\/+$/, '')}/${String(keyOrUrl).replace(/^\/+/, '')}` : '';
}

// --- UPDATE: cho phép build designs từ fulfillment_file hoặc svgFile/snapshotImage ---
function buildMerchizeDesigns(ff, item = {}) {
    // 1) Thử đọc từ fulfillment_file (Map/object/string) như cũ
    const designs = (() => {
        if (!ff) return {};
        const get = (obj, k) => obj?.get ? obj.get(k) : obj?.[k];

        if (ff instanceof Map || (typeof ff === 'object' && !Array.isArray(ff))) {
            const obj = ff instanceof Map ? Object.fromEntries(ff.entries()) : ff;
            const front = get(obj, 'front');
            const back = get(obj, 'back');
            const left = get(obj, 'left_sleeve') || get(obj, 'sleeve_left');
            const right = get(obj, 'right_sleeve') || get(obj, 'sleeve_right');
            const hood = get(obj, 'hood');
            const sleeve = left || right || undefined;

            const out = {};
            if (front) out.design_front = String(front);
            if (back) out.design_back = String(back);
            if (sleeve) out.design_sleeve = String(sleeve);
            if (hood) out.design_hood = String(hood);
            return out;
        }

        if (typeof ff === 'string') {
            return ff ? { design_front: ff } : {};
        }
        return {};
    })();

    // 2) Nếu chưa có design_* thì fallback từ svgFile
    const hasAnyDesign = ['design_front', 'design_back', 'design_sleeve', 'design_hood']
        .some(k => !!designs[k]);

    if (!hasAnyDesign) {
        const svg = item?.svgFile;
        if (svg) {
            designs.design_front = resolveAssetUrl(svg);
        }
    }

    return designs;
}

// --- UPDATE: attributes giữ nguyên ---

function pickCompletedItems(orderObj, allowedStatuses) {
    const whitelist = (Array.isArray(allowedStatuses) && allowedStatuses.length)
        ? allowedStatuses.map(s => String(s).trim().toLowerCase())
        : ['complete']; // default

    return (orderObj.items || []).filter(i =>
        whitelist.includes(String(i.scale_status || '').toLowerCase())
    );
}

function buildPayload(orderObj, options = {}) {
    // Lấy allowed statuses từ options hoặc env
    const envStatuses = (process.env.MERCHIZE_ALLOWED_STATUSES || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const allowedStatuses = options.allowedStatuses?.length ? options.allowedStatuses : envStatuses;

    const completedItems = pickCompletedItems(orderObj, allowedStatuses);

    const shipping = orderObj.customer_infor || {};
    return {
        order_id: String(orderObj.orderId || orderObj._id || ''),
        identifier:
            orderObj?.shop_domain ||
            orderObj?.identifier ||
            process.env.MERCHIZE_IDENTIFIER ||
            'system.lngmerch.co',
        shipping_info: {
            full_name: shipping.name || '',
            address_1: shipping.address || '',
            address_2: shipping.address_2 || '',
            city: shipping.city || '',
            state: shipping.state || '',
            postcode: shipping.zip_code || '',
            country: shipping.country || '',
            email: shipping.email || '',
            phone: shipping.phone_number || '',
        },
        tags: Array.isArray(orderObj.tags) ? orderObj.tags : [],
        items: completedItems.map(buildLineItem),
    };
}

function buildLineItem(item = {}) {
    const designs = buildMerchizeDesigns(item.fulfillment_file, item);

    return {
        name: item?.cost_breakdown?.itemDisplayName || item?.title || item?.name || 'Custom Product',
        product_id: item?.cost_breakdown?.matchedSku || null,
        sku: item?.cost_breakdown?.matchedSku || item?.sku || null,
        merchize_sku: item?.cost_breakdown?.matchedSku || item?.vendorVariantSku || null,
        quantity: Number(item?.quantity || 1),
        price: Number(item?.price) || Number(item?.cost_breakdown?.unit_price) || null,
        currency: item?.currency || 'USD',
        image: pickMockup(item) || null,
        ...designs,
        attributes: buildAttributes(item),
    };
}

// --- helper: validate all line items have merchize_sku ---
function precheckMerchizeSkus(payload) {
    const bad = [];
    for (const it of payload.items || []) {
        // yêu cầu có merchize_sku / product_id tối thiểu
        if (!it.merchize_sku && !it.product_id && !it.sku) {
            bad.push({ name: it.name, reason: 'missing merchize_sku/product_id' });
        }
    }
    if (bad.length) {
        const err = new Error('Missing SKU for some items');
        err.code = 'MISSING_SKU';
        err.details = bad;
        throw err;
    }
}

// --- helper: treat 200 but vendor rejects as an error ---
function assertMerchizeAccepted(resp) {
    const data = resp?.data ?? {};

    // Merchize thường có { success: false, message: "Invalid Merchize SKU: ..." }
    const successField = typeof data.success === 'boolean' ? data.success : undefined;

    // fallback: nếu có field errors hoặc message chứa "invalid"/"error"
    const hasErrors = Array.isArray(data.errors) && data.errors.length > 0;
    const msg = (data.message || '').toString();

    const looksBad =
        successField === false ||
        hasErrors ||
        /invalid|error|not\s*found|duplicate/i.test(msg);

    if (looksBad) {
        const err = new Error(
            `Merchize rejected order: ${msg || 'Unknown error'}`
        );
        err.code = 'VENDOR_REJECTED';
        err.vendor = 'merchize';
        err.response = data; // để controller ghi log vào vendor_submissions
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
    console.log('Payload:', JSON.stringify(payload));

    if (!payload.items?.length) {
        const err = new Error('No items matching allowed statuses to send.');
        err.code = 'NO_LINE_ITEMS';
        throw err;
    }

    const hasAnyDesign = payload.items.some(it =>
        ['design_front', 'design_back', 'design_sleeve', 'design_hood'].some(k => !!it[k])
    );
    if (!hasAnyDesign) {
        const err = new Error('No design files found (fulfillment_file/svg fallback missing).');
        err.code = 'NO_PRINT_FILES';
        throw err;
    }

    precheckMerchizeSkus(payload);

    const baseURL =
        process.env.MERCHIZE_BASE_URL ||
        'https://bo-group-1-2.merchize.com/403c7ev/bo-api';
    const endpoint = `${baseURL.replace(/\/+$/, '')}/order/external/orders`;
    const token = process.env.MERCHIZE_ACCESS_TOKEN;
    if (!token) {
        const err = new Error('Missing MERCHIZE_ACCESS_TOKEN in env.');
        err.code = 'NO_TOKEN';
        throw err;
    }

    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
    };

    const resp = await axios.post(endpoint, payload, { headers });

    // Giữ nguyên check HTTP, nhưng QUAN TRỌNG: kiểm tra body
    if (resp.status >= 300) {
        throw new Error(`Merchize responded with status ${resp.status}`);
    }

    const data = assertMerchizeAccepted(resp); // <-- sẽ throw nếu success=false
    const externalId =
        data?.id || data?.order_id || data?.data?.order_id || null;

    return {
        vendorKey: 'merchize',
        alreadySent: false,
        response: data,
        externalId,
    };
}

module.exports = {
    key: 'merchize',
    canHandle: () => true,
    send
};

