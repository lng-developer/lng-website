// services/fulfillment/index.js
const grabink = require('./providers/grabink');
const merchfox = require('./providers/merchfox');
const merchize = require('./providers/merchize');
const printway = require('./providers/printway');
const mangotee = require('./providers/mangotee'); // <<< NEW
const lenful = require('./providers/lenful'); // <<< NEW
const lng = require('./providers/lng');
const ss88 = require('./providers/ss88');
const pgprint = require('./providers/pgprint'); // <<< NEW
const luxurypro = require('./providers/luxurypro');
const onos = require('./providers/onos');


const PROVIDERS = [grabink, merchfox, merchize, printway, mangotee, lng, lenful, ss88, pgprint, luxurypro, onos];
const PROVIDER_MAP = new Map(PROVIDERS.map(p => [p.key, p]));

/**
 * Lưu submission theo vendor key (idempotent per vendor).
 * - Ưu tiên dùng order.vendor_submissions[key], fallback sang grabink_submission (để tương thích code cũ).
 */
function readSubmission(orderDoc, vendorKey) {
    const vs = orderDoc.vendor_submissions || {};
    if (vs[vendorKey]) return vs[vendorKey];

    if (vendorKey === 'grabink' && orderDoc.grabink_submission) {
        return orderDoc.grabink_submission;
    }
    return null;
}

function writeSubmission(orderDoc, vendorKey, submission) {
    orderDoc.vendor_submissions = orderDoc.vendor_submissions || {};
    orderDoc.vendor_submissions[vendorKey] = submission;
    if (typeof orderDoc.markModified === 'function') {
        orderDoc.markModified('vendor_submissions');
    }

    // Backward-compat cho grabink
    if (vendorKey === 'grabink') {
        orderDoc.grabink_submission = submission;
    }
}

function compactError(error) {
    return {
        message: error?.response?.data?.message || error?.message || String(error || 'Unknown error'),
        code: error?.code || error?.response?.status || null,
        response: error?.response?.data || null,
    };
}

/**
 * Gửi đơn tới vendor cụ thể.
 * @param {Document} orderDoc - Mongoose doc
 * @param {string} vendorKey - 'grabink' | 'merchfox' | 'merchize' | 'printway' | 'mangotee' | 'lng' | 'lenful' | 'ss88' | 'pgprint' | 'luxurypro' | 'onos'
 */
async function sendToVendor(orderDoc, vendorKey) {
    const provider = PROVIDER_MAP.get(vendorKey);
    if (!provider) {
        const err = new Error(`Unknown vendor provider: ${vendorKey}`);
        err.code = 'UNKNOWN_VENDOR';
        throw err;
    }

    const prev = readSubmission(orderDoc, vendorKey);
    if (prev?.sent) {
        return { alreadySent: true, response: prev?.last_response, vendorKey };
    }

    let data;
    let externalId;
    try {
        ({ data, externalId } = await provider.send(orderDoc));
    } catch (error) {
        writeSubmission(orderDoc, vendorKey, {
            sent: false,
            sent_at: null,
            attempt_count: (prev?.attempt_count || 0) + 1,
            last_response: error?.response?.data || null,
            last_error: compactError(error),
            external_id: prev?.external_id || null,
            failed_at: new Date(),
        });
        await orderDoc.save();
        throw error;
    }

    const submission = {
        sent: true,
        sent_at: new Date(),
        attempt_count: (prev?.attempt_count || 0) + 1,
        last_response: data,
        last_error: null,
        external_id: externalId || null,
    };
    writeSubmission(orderDoc, vendorKey, submission);

    // Trạng thái tổng
    orderDoc.scale_overall_status = 'Sent';
    orderDoc.status = 'Fulfilled';
    orderDoc.fulfilled_at = new Date();
    if (!orderDoc.external_order_id && externalId) {
        orderDoc.external_order_id = externalId;
    }
    await orderDoc.save();

    return { alreadySent: false, response: data, vendorKey };
}

/**
 * Auto-route: chọn provider dựa vào order hoặc tham số mặc định.
 * Ưu tiên:
 *  1) explicit vendorKey truyền vào
 *  2) order.vendor (nếu có)
 *  3) provider.canHandle(orderDoc) === true (theo thứ tự trong PROVIDERS)
 *  4) fallback 'grabink'
 */
async function send(orderDoc, vendorKey) {
    let key = vendorKey || orderDoc.vendor;

    if (!key) {
        const auto = PROVIDERS.find(p => {
            try {
                return typeof p.canHandle === 'function' ? !!p.canHandle(orderDoc) : false;
            } catch {
                return false;
            }
        });
        key = auto?.key || 'grabink';
    }

    return sendToVendor(orderDoc, key);
}

module.exports = { send, sendToVendor, PROVIDERS };
