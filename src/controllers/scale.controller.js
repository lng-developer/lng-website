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

  if (allComplete) return 'Ready';
  if (anyPendingOrComplete) return 'Pending';
  return 'Need Scale';
}

/**
 * Build payload toàn bộ đơn gửi Grabink
 * [Chưa xác minh]: Map lại field theo spec thật của Grabink nếu khác.
 */
function buildGrabinkOrderPayload(order) {
  return {
    api_key: process.env.GRABINK_API_KEY, // Lấy từ .env
    line_items: order.items.map(item => {
      return {
        // Nếu đã có mapping vendor_product → variant_id thì map, còn không thì để null hoặc 0
        variant_id: item.cost_breakdown?.vendorProductId || null, // [Chưa xác minh]
        sku: item.sku,
        product_name: item.cost_breakdown?.itemDisplayName || item.title,
        quantity: item.quantity,

        // mockup hình ảnh front/back
        mockup: item.snapshotImage || item.baseImage?.imageUrl,
        mockup_back: item.baseImage?.imageUrl || null,

        // print_files: file fulfillment (scale đã upload) + svg nếu cần
        print_files: [
          ...(item.fulfillment_file ? [{ key: "front", url: item.fulfillment_file }] : []),
          ...(item.svgFile ? [{ key: "svg", url: item.svgFile }] : [])
        ]
      };
    }),
    is_scan_label: false,
    order_status: "new",
    ref_id: order.orderId,
    shipping_label: null, // chưa có label => để null
    shipping_method: (order.shipping_type || "Standard").toLowerCase(),
    address: {
      name: order.customer_infor?.name,
      email: order.customer_infor?.email,
      phone: order.customer_infor?.phone_number,
      country: order.customer_infor?.country,
      state: order.customer_infor?.state,
      city: order.customer_infor?.city,
      street1: order.customer_infor?.address,
      street2: order.customer_infor?.address_2 || null,
      zip: order.customer_infor?.zip_code
    }
  };
}


/**
 * Gửi toàn bộ order sang Grabink (idempotent)
 * - Không gửi lại nếu order.grabink_submission.sent = true
 * - Thành công: set sent=true, scale_overall_status='Sent'
 * - Thất bại: ném lỗi để caller xử lý (thường set 'Failed')
 *
 * [Chưa xác minh] tiêu chí thành công và trường external_id.
 */
async function sendWholeOrderToGrabink(order) {
  if (order.grabink_submission?.sent) {
    return { alreadySent: true, response: order.grabink_submission?.last_response };
  }

  const payload = buildGrabinkOrderPayload(order);
  const endpoint = process.env.GRABINK_ENDPOINT || 'https://be.grabink.co/api/external/order';
  const headers = {
    'Content-Type': 'application/json',
    ...(process.env.GRABINK_API_KEY && { 'Authorization': `Bearer ${process.env.GRABINK_API_KEY}` })
  };

  const resp = await axios.post(endpoint, payload, { headers });

  // [Chưa xác minh]: cập nhật điều kiện thành công theo response Grabink
  if (resp.status >= 300) {
    throw new Error(`Grabink responded with status ${resp.status}`);
  }

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
 *   - nếu tất cả items Complete => gửi cả Order sang Grabink
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

    // if (item.scale_status !== 'Pending') {
    //   return res.status(409).json({ message: `Only Pending can be confirmed/rejected. Current: ${item.scale_status}` });
    // }

    if (d === 'reject') {
      item.scale_status = 'Need Scale';
      // (tuỳ chọn) clear file khi reject:
      item.fulfillment_file = '';
      // (tuỳ chọn) lưu note vào item nếu bạn thêm field scale_note trong model
      order.scale_overall_status = computeOverallScaleStatus(order);
      await order.save();
      return res.json({
        message: 'Scale rejected. Item back to Need Scale.',
        item_scale_status: item.scale_status,
        order_scale_overall_status: order.scale_overall_status
      });
    }

    // approve
    if (!item.fulfillment_file) {
      return res.status(400).json({ message: 'Missing fulfillment_file. Please upload scale first.' });
    }

    item.scale_status = 'Complete';
    order.scale_overall_status = computeOverallScaleStatus(order);

    // Nếu tất cả items đã Complete & chưa gửi thì gửi cả đơn
    if (order.scale_overall_status === 'Ready' && !(order.grabink_submission?.sent)) {
      try {
        const result = await sendWholeOrderToGrabink(order);
        return res.json({
          message: result.alreadySent ? 'Order already sent to Grabink.' : 'Approved and order sent to Grabink.',
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
          message: 'Approved but sending order to Grabink failed. Overall status set to Failed.',
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
 * Retry gửi toàn bộ order sang Grabink khi Ready/Failed
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

    const result = await sendWholeOrderToGrabink(order);
    return res.json({
      message: result.alreadySent ? 'Order already sent to Grabink.' : 'Order sent to Grabink.',
      grabink_response: result.response
    });
  } catch (err) {
    return res.status(500).json({ message: 'Retry failed', error: err.message });
  }
};

module.exports = {
  uploadFulfillmentFileForItem,
  confirmScaleForItem,
  retrySendGrabink
};
