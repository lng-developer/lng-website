// controllers/orderFulfillment.controller.js
const multer = require('multer');
const axios = require('axios');
const db = require('../models');
const OrderCustomProduct = db.orderCustomProduct;
const cloudinary = require('../utils/cloudinary');

const upload = multer({ storage: multer.memoryStorage() });

// ============================
// Cloudinary helper
// ============================
function uploadStreamToCloudinary(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'image', overwrite: true, ...opts },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// ============================
// Helpers for scale workflow
// ============================
/**
 * Tính trạng thái tổng cho Order dựa trên items.scale_status
 * - Ready: tất cả items = Complete
 * - Pending: có ít nhất 1 item Pending/Complete nhưng chưa đủ tất cả Complete
 * - Need Scale: không có item Pending/Complete
 */
function computeOverallScaleStatus(orderDoc) {
  const items = orderDoc.items || [];
  if (items.length === 0) return 'Need Scale';

  const statuses = items.map(i => i.scale_status || 'Need Scale');
  const allComplete = statuses.every(s => s === 'Complete');
  const anyPendingOrComplete = statuses.some(s => s === 'Pending' || s === 'Complete');
  const anyRejected = statuses.some(s => s === 'QC Rejected');

  if (anyRejected) return 'QC Rejected';
  if (allComplete) return 'Ready';
  if (anyPendingOrComplete) return 'Pending';
  return 'Need Scale';
}


/**
 * Map shipping_type nội bộ -> shipping_method của Grablink
 */
function mapShippingMethod(shipping_type = 'Standard') {
  const t = String(shipping_type).toLowerCase();
  if (t.includes('overnight')) return 'overnight';
  if (t.includes('second')) return 'second_day';
  if (t.includes('expedited')) return 'expedited';
  if (t.includes('economy')) return 'economy';
  // chuẩn mẫu: "standard"
  return 'standard';
}

/**
 * Build payload 1 ĐƠN duy nhất gửi Grablink
 * - Theo mẫu bạn cung cấp
 * - line_items chỉ lấy các item đã Complete để an toàn
 * - variant_id: hiện chưa có numeric mapping -> để null (bạn có thể map từ VendorProduct → variant_id số nếu có bảng mapping)
 */
function buildGrabinkOrderPayload(order) {
  const completedItems = (order.items || []).filter(i => i.scale_status === 'Complete');

  return {
    api_key: process.env.GRABINK_API_KEY, // bắt buộc có trong .env
    line_items: completedItems.map(item => ({
      // TODO: map đúng numeric variant_id nếu bạn có bảng mapping; tạm để null
      variant_id: null, // hoặc Number(item.cost_breakdown?.variant_id) nếu có
      sku: item.cost_breakdown.matchedSku,
      product_name: item.cost_breakdown?.itemDisplayName || item.title,
      quantity: item.quantity,

      // mockup / mockup_back
      mockup: item.baseImage?.imageUrl || null,
      mockup_back: "",

      // print_files: dùng file scale (fulfillment_file) là chủ đạo
      print_files: [
        ...(item.fulfillment_file ? [{ key: 'front', url: item.fulfillment_file }] : []),
        // Nếu Grablink không nhận svg, có thể bỏ dòng sau:
        ...(item.svgFile ? [{ key: 'svg', url: item.svgFile }] : [])
      ]
    })),

    is_scan_label: false,
    order_status: 'new',
    ref_id: order.orderId,
    shipping_label: null, // nếu có url label thì set, còn không để null
    shipping_method: mapShippingMethod(order.shipping_type),

    address: {
      name: order.customer_infor?.name || '',
      email: order.customer_infor?.email || '',
      phone: order.customer_infor?.phone_number || '',
      // Lưu ý: mẫu của bạn ghi country là tên quốc gia (vd "United States")
      // Dữ liệu đang là mã "US" -> có thể cần map theo yêu cầu Grablink
      country: order.customer_infor?.country === 'US' ? 'United States' : (order.customer_infor?.country || ''),
      state: order.customer_infor?.state || '',
      city: order.customer_infor?.city || '',
      street1: order.customer_infor?.address || '',
      street2: order.customer_infor?.address_2 || null,
      zip: order.customer_infor?.zip_code || ''
    }
  };
}

/**
 * Gửi 1 ĐƠN (duy nhất) sang Grablink (idempotent)
 * - KHÔNG lặp qua nhiều đơn; chỉ nhận đúng 1 order object
 * - Không gửi lại nếu order.grabink_submission.sent = true
 * - Thành công: set sent=true, scale_overall_status='Sent'
 * - Thất bại: ném lỗi để caller xử lý (thường set 'Failed')
 */
async function sendOrderToGrablink(order) {
  if (order.grabink_submission?.sent) {
    return { alreadySent: true, response: order.grabink_submission?.last_response };
  }

  const payload = buildGrabinkOrderPayload(order);

  // Chặn case line_items rỗng (không có item Complete)
  if (!payload.line_items || payload.line_items.length === 0) {
    const err = new Error('No completed items to send.');
    err.code = 'NO_LINE_ITEMS';
    throw err;
  }

  const endpoint = process.env.GRABINK_ENDPOINT || 'https://be.grabink.co/api/external/order';
  const headers = { 'Content-Type': 'application/json' };

  const resp = await axios.post(endpoint, payload, { headers });

  // Tiêu chí thành công: 2xx
  if (resp.status >= 300) throw new Error(`Grablink responded with status ${resp.status}`);

  const externalId = resp.data?.id || resp.data?.orderId || null;

  order.grabink_submission = {
    sent: true,
    sent_at: new Date(),
    attempt_count: (order.grabink_submission?.attempt_count || 0) + 1,
    last_response: resp.data,
    external_id: externalId
  };
  order.scale_overall_status = 'Sent';
  await order.save();

  return { alreadySent: false, response: resp.data };
}

// ============================
// Controllers
// ============================

/**
 * Upload "scale" cho 1 item:
 * - Lưu URL vào items.fulfillment_file
 * - Cập nhật items.scale_status = 'Pending'
 * - Cập nhật order.scale_overall_status
 */
const uploadFulfillmentFileForItem = [
  upload.single('file'),
  async (req, res) => {
    try {
      const { orderId, orderItemId } = req.params;
      if (!req.file) return res.status(400).json({ message: 'Missing file' });

      const order = await OrderCustomProduct.findOne({ orderId });
      if (!order) return res.status(404).json({ message: 'Order not found' });

      const item = order.items.find(i => i.orderItemId === orderItemId);
      if (!item) return res.status(404).json({ message: 'Order item not found' });

      const public_id = `fulfillment_files/${orderId}-${orderItemId}`;
      const up = await uploadStreamToCloudinary(req.file.buffer, { public_id });

      item.fulfillment_file = up.secure_url; // chỉ lưu URL
      item.scale_status = 'Pending';         // chuyển trạng thái item
      order.scale_overall_status = computeOverallScaleStatus(order);

      await order.save();

      return res.json({
        message: 'Uploaded fulfillment file successfully',
        url: up.secure_url,
        item_scale_status: item.scale_status,
        order_scale_overall_status: order.scale_overall_status
      });
    } catch (err) {
      return res.status(500).json({ message: 'Upload failed', error: err.message });
    }
  }
];

/**
 * Xác nhận scale cho 1 item:
 * - Body: { decision: "approve" | "reject", note?: string }
 * - approve:
 *   - yêu cầu item đã có fulfillment_file
 *   - đặt item.scale_status = 'Complete'
 *   - nếu tất cả items Complete => GỬI 1 ĐƠN duy nhất sang Grablink
 * - reject:
 *   - đặt item.scale_status = 'Need Scale'
 *   - (tuỳ chọn) xoá fulfillment_file
 */
const confirmScaleForItem = async (req, res) => {
  try {
    const { orderId, orderItemId } = req.params;
    const { decision, note } = req.body || {};

    const d = String(decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(d)) {
      return res.status(400).json({ message: 'Invalid decision. Must be "approve" or "reject".' });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const item = order.items.find(i => i.orderItemId === orderItemId);
    if (!item) return res.status(404).json({ message: 'Order item not found' });

    if (d === 'reject') {
      item.scale_status = 'QC Rejected';
      item.fulfillment_file = '';   // clear file khi reject
      if (note) item.qc_note = note; // lưu note QC
      order.scale_overall_status = 'QC Rejected'; // bất kỳ reject nào thì order cũng QC Rejected

      await order.save();
      return res.json({
        message: 'Scale rejected. Item set to QC Rejected.',
        item_scale_status: item.scale_status,
        qc_note: item.qc_note,
        order_scale_overall_status: order.scale_overall_status
      });
    }

    // approve
    if (!item.fulfillment_file) {
      return res.status(400).json({ message: 'Missing fulfillment_file. Please upload scale first.' });
    }

    item.scale_status = 'Complete';
    if (note) item.qc_note = note; // nếu muốn lưu note cả khi approve
    order.scale_overall_status = computeOverallScaleStatus(order);

    // Nếu tất cả items đã Complete & chưa gửi thì GỬI 1 ĐƠN duy nhất
    if (order.scale_overall_status === 'Ready' && !(order.grabink_submission?.sent)) {
      try {
        const result = await sendOrderToGrablink(order);
        return res.json({
          message: result.alreadySent ? 'Order already sent to Grablink.' : 'Approved and order sent to Grablink.',
          item_scale_status: item.scale_status,
          order_scale_overall_status: order.scale_overall_status,
          grabink_response: result.response
        });
      } catch (e) {
        // Gửi thất bại -> ghi nhận Failed để có thể retry sau
        order.grabink_submission = {
          ...(order.grabink_submission || {}),
          sent: false,
          attempt_count: (order.grabink_submission?.attempt_count || 0) + 1,
          last_response: { error: e.message, at: new Date() }
        };
        order.scale_overall_status = 'Failed';
        await order.save();
        return res.status(502).json({
          message: 'Approved but sending order to Grablink failed. Overall status set to Failed.',
          error: e.message
        });
      }
    }

    // Chưa đủ Complete (đơn nhiều item) -> chỉ lưu trạng thái, chờ các item còn lại
    await order.save();
    return res.json({
      message: 'Item approved. Waiting for other items to be approved.',
      item_scale_status: item.scale_status,
      order_scale_overall_status: order.scale_overall_status
    });
  } catch (err) {
    return res.status(500).json({ message: 'Confirm failed', error: err.message });
  }
};

/**
 * Retry gửi lại 1 ĐƠN duy nhất sang Grablink khi Ready/Failed
 */
const retrySendGrabink = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const okToSend =
      (order.scale_overall_status === 'Ready' || order.scale_overall_status === 'Failed') &&
      !(order.grabink_submission?.sent);

    if (!okToSend) {
      return res.status(409).json({
        message: `Order is not ready to send. Current: ${order.scale_overall_status}, sent=${!!(order.grabink_submission?.sent)}`
      });
    }

    const result = await sendOrderToGrablink(order);
    return res.json({
      message: result.alreadySent ? 'Order already sent to Grablink.' : 'Order sent to Grablink.',
      grabink_response: result.response
    });
  } catch (err) {
    return res.status(500).json({ message: 'Retry failed', error: err.message });
  }
};

/**
 * CS cập nhật ghi chú cho 1 item
 * PUT /api/scale/orders/:orderId/items/:orderItemId/cs-note
 * Body: { cs_note: string }  // cho phép rỗng để xóa
 */
const updateCSNoteForItem = async (req, res) => {
  try {
    const { orderId, orderItemId } = req.params;
    let { cs_note } = req.body || {};

    // Chuẩn hóa & validate đơn giản
    cs_note = typeof cs_note === 'string' ? cs_note.trim() : '';
    if (cs_note.length > 2000) {
      return res.status(400).json({ message: 'cs_note vượt quá 2000 ký tự.' });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const item = order.items.find(i => i.orderItemId === orderItemId);
    if (!item) return res.status(404).json({ message: 'Order item not found' });

    item.cs_note = cs_note; // ghi đè hoặc xóa (nếu rỗng)
    await order.save();

    return res.json({
      message: 'CS note updated.',
      orderId,
      orderItemId,
      cs_note: item.cs_note
    });
  } catch (err) {
    return res.status(500).json({ message: 'Update CS note failed', error: err.message });
  }
};


module.exports = {
  uploadFulfillmentFileForItem,
  confirmScaleForItem,
  retrySendGrabink,
  updateCSNoteForItem
};
