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


function buildPrintFiles(ff) {
  if (!ff) return [];

  // Map internal keys → Grabink keys
  const keyMap = {
    front: 'front',
    back: 'back',
    left_sleeve: 'sleeve_left',
    right_sleeve: 'sleeve_right',
    collar: 'chest_left',   // ⚠️ bạn cần confirm chỗ này: Collar nên map sang chest_left hay chest_right?
  };

  // Mongoose Map
  if (ff instanceof Map) {
    return Array.from(ff.entries())
      .filter(([, v]) => !!v)
      .map(([k, v]) => ({
        key: keyMap[k] || String(k).toLowerCase(),
        url: String(v),
      }));
  }

  // Plain object
  if (typeof ff === 'object' && !Array.isArray(ff)) {
    return Object.entries(ff)
      .filter(([, v]) => !!v)
      .map(([k, v]) => ({
        key: keyMap[k] || String(k).toLowerCase(),
        url: String(v),
      }));
  }

  // Legacy string (1 link -> front)
  if (typeof ff === 'string') {
    return ff ? [{ key: 'front', url: ff }] : [];
  }

  return [];
}



/**
 * Build payload 1 ĐƠN duy nhất gửi Grablink
 * - Theo mẫu bạn cung cấp
 * - line_items chỉ lấy các item đã Complete để an toàn
 * - variant_id: hiện chưa có numeric mapping -> để null (bạn có thể map từ VendorProduct → variant_id số nếu có bảng mapping)
 */
function buildGrabinkOrderPayload(orderObj) {
  const completedItems = (orderObj.items || []).filter(i => i.scale_status === 'Complete');

  return {
    api_key: process.env.GRABINK_API_KEY,
    line_items: completedItems.map(item => {
      const printFiles = [
        ...buildPrintFiles(item.fulfillment_file),
        ...(item.svgFile ? [{ key: 'svg', url: item.svgFile }] : [])
      ];

      return {
        variant_id: null, // hoặc Number(item.cost_breakdown?.variant_id)
        sku: item.cost_breakdown?.matchedSku,
        product_name: item.cost_breakdown?.itemDisplayName || item.title,
        quantity: item.quantity,
        mockup: item.baseImage?.imageUrl || null,
        mockup_back: "",
        print_files: printFiles
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
      zip: orderObj.customer_infor?.zip_code || ''
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
async function sendOrderToGrablink(orderDoc) {
  if (orderDoc.grabink_submission?.sent) {
    return { alreadySent: true, response: orderDoc.grabink_submission?.last_response };
  }

  // ✨ Quan trọng: convert sang POJO để tránh circular
  const orderObj = orderDoc.toObject({ getters: false, virtuals: false });

  const payload = buildGrabinkOrderPayload(orderObj);

  if (!payload.line_items || payload.line_items.length === 0) {
    const err = new Error('No completed items to send.');
    err.code = 'NO_LINE_ITEMS';
    throw err;
  }

  // (tuỳ) nếu yêu cầu phải có print_files:
  const anyHasPrint = payload.line_items.some(li => Array.isArray(li.print_files) && li.print_files.length > 0);
  if (!anyHasPrint) {
    const err = new Error('No print_files found for completed items.');
    err.code = 'NO_PRINT_FILES';
    throw err;
  }

  const endpoint = process.env.GRABINK_ENDPOINT || 'https://be.grabink.co/api/external/order';
  const headers = { 'Content-Type': 'application/json' };

  const resp = await axios.post(endpoint, payload, { headers });
  if (resp.status >= 300) throw new Error(`Grablink responded with status ${resp.status}`);

  const externalId = resp.data?.id || resp.data?.orderId || null;

  orderDoc.grabink_submission = {
    sent: true,
    sent_at: new Date(),
    attempt_count: (orderDoc.grabink_submission?.attempt_count || 0) + 1,
    last_response: resp.data, // resp.data là plain JSON
    external_id: externalId
  };
  orderDoc.scale_overall_status = 'Sent';
  await orderDoc.save();

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
  upload.array('files'),
  async (req, res) => {
    try {
      const { orderId, orderItemId } = req.params;
      const { meta } = req.body; // JSON string: [{"position":"front"},{"position":"back"}]

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: 'Missing files' });
      }

      let positions = [];
      try {
        positions = JSON.parse(meta);
      } catch (err) {
        return res.status(400).json({ message: 'Invalid meta JSON' });
      }

      if (positions.length !== req.files.length) {
        return res.status(400).json({ message: 'Files count not match positions' });
      }

      const order = await OrderCustomProduct.findOne({ orderId });
      if (!order) return res.status(404).json({ message: 'Order not found' });

      const item = order.items.find(i => i.orderItemId === orderItemId);
      if (!item) return res.status(404).json({ message: 'Order item not found' });

      // --- Đảm bảo fulfillment_file là Map, xử lý dữ liệu cũ ---
      const ff = item.fulfillment_file;
      if (!ff) {
        item.fulfillment_file = new Map();
      } else if (typeof ff === 'string') {
        // dữ liệu cũ đang là "", ép về Map rỗng
        item.fulfillment_file = new Map();
      } else if (!(ff instanceof Map)) {
        // nếu là plain object => convert sang Map
        item.fulfillment_file = new Map(Object.entries(ff));
      }

      // --- Upload & gán key ---
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const pos = String(positions[i]?.position || '').trim().toLowerCase();
        if (!pos) return res.status(400).json({ message: `Missing position for file index ${i}` });

        const public_id = `fulfillment_files/${orderId}-${orderItemId}-${pos}`;
        const up = await uploadStreamToCloudinary(file.buffer, { public_id });

        item.fulfillment_file.set(pos, up.secure_url);
      }

      item.scale_status = 'Pending';
      order.scale_overall_status = computeOverallScaleStatus(order);

      // mark modified cho nested Map trong subdoc
      item.markModified('fulfillment_file');

      await order.save();

      return res.json({
        message: 'Uploaded fulfillment files successfully',
        fulfillment_file: Object.fromEntries(item.fulfillment_file), // trả về dạng object cho dễ đọc
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
      // Clear thống nhất theo kiểu Map rỗng:
      item.fulfillment_file = new Map();
      item.markModified('fulfillment_file');
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
