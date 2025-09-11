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
        // order_id: String(orderObj.orderId || orderObj._id || ''),
        order_id: "Test",
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
        product_id: item?.cost_breakdown?.merchize_product_id || undefined,
        sku: item?.cost_breakdown?.matchedSku || item?.sku || undefined,
        merchize_sku: item?.cost_breakdown?.merchize_sku || item?.vendorVariantSku || undefined,
        quantity: Number(item?.quantity || 1),
        price: Number(item?.price) || Number(item?.cost_breakdown?.unit_price) || undefined,
        currency: item?.currency || 'USD',
        image: pickMockup(item) || undefined,
        ...designs,
        attributes: buildAttributes(item),
    };
}

async function send(orderDoc, options = {}) {
    const orderObj =
        typeof orderDoc?.toObject === 'function'
            ? orderDoc.toObject({ getters: false, virtuals: false })
            : orderDoc;

    const payload = buildPayload(orderObj, options);

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

    const baseURL =
        process.env.MERCHIZE_BASE_URL ||
        'https://bo-group-1-2.merchize.com/4cwa17f/bo-api';
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
    if (resp.status >= 300) {
        throw new Error(`Merchize responded with status ${resp.status}`);
    }

    const externalId = resp.data?.id || resp.data?.order_id || resp.data?.data?.order_id || null;
    return { data: resp.data, externalId };
}

module.exports = {
    key: 'merchize',
    canHandle: () => true,
    send
};
