// services/fulfillment/providers/grabink.js
const axios = require('axios');

/** Mỗi vendor tự map shipping theo cách riêng */
function mapShippingMethod(shipping_type = 'Standard') {
    const t = String(shipping_type || '').toLowerCase();
    if (t.includes('overnight')) return 'overnight';
    if (t.includes('second')) return 'second_day';
    if (t.includes('expedited')) return 'expedited';
    if (t.includes('economy')) return 'economy';
    return 'standard';
}

/** Mỗi vendor tự build print files theo key họ yêu cầu (Grabink) */
function buildGrabinkPrintFiles(ff, item) {
    if (!ff) return [];

    // Với Grabink: map các key nội bộ sang keys yêu cầu
    const keyMap = {
        front: 'front',
        back: 'back',
        left_sleeve: 'sleeve_left',
        right_sleeve: 'sleeve_right',
        collar: 'chest_left', // nếu Grabink cần đổi, chỉnh tại đây mà không ảnh hưởng vendor khác
    };

    // Hỗ trợ Map (mongoose), object, và legacy string
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

/** Build payload dành riêng cho Grabink */
function buildPayload(orderObj) {
    const completedItems = (orderObj.items || []).filter(i => i.scale_status === 'Complete');

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
            country: orderObj.customer_infor?.country === 'US'
                ? 'United States'
                : (orderObj.customer_infor?.country || ''),
            state: orderObj.customer_infor?.state || '',
            city: orderObj.customer_infor?.city || '',
            street1: orderObj.customer_infor?.address || '',
            street2: orderObj.customer_infor?.address_2 || null,
            zip: orderObj.customer_infor?.zip_code || '',
        },
    };
}

async function send(orderDoc) {
    const orderObj = orderDoc.toObject({ getters: false, virtuals: false });
    const payload = buildPayload(orderObj);

    if (!payload.line_items?.length) {
        const err = new Error('No completed items to send.');
        err.code = 'NO_LINE_ITEMS';
        throw err;
    }
    const anyHasPrint = payload.line_items.some(li => Array.isArray(li.print_files) && li.print_files.length > 0);
    if (!anyHasPrint) {
        const err = new Error('No print_files found for completed items.');
        err.code = 'NO_PRINT_FILES';
        throw err;
    }

    const endpoint = process.env.GRABINK_ENDPOINT || 'https://be.grabink.co/api/external/order';
    const headers = { 'Content-Type': 'application/json' };
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
