// controllers/orderFulfillment.controller.js
const multer = require('multer');
const axios = require('axios');
const mongoose = require("mongoose")
const db = require('../models');
const OrderCustomProduct = db.orderCustomProduct;
const cloudinary = require('../utils/cloudinary');
const VendorProduct = db.vendorProduct;
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
 * SCALE LIST
 * Trả về danh sách order + item với các filter theo scale_overall_status, date range, search, shopName
 * Giữ nguyên logic phân trang, alias trạng thái, và filter Pending items khi chỉ xem Pending.
 */
const getScaleList = async (req, res) => {
  try {
    const {
      page = 1,
      perPage = 10,
      from,
      to,
      scale_status,      // filter theo scale_overall_status (order-level)
      search,            // regex theo orderId (+ mở rộng sku/orderItemId/email/name)
      shopName
    } = req.query;

    const KNOWN = ['Need Scale', 'Pending', 'Ready', 'Sent', 'Failed', 'QC Rejected'];

    // Map alias từ query về canonical trong DB
    const canon = s => {
      const t = String(s || '').trim();
      if (!t) return '';
      if (/^complete$/i.test(t)) return 'Ready';                // alias
      if (/^qc\s*reject(?:ed)?$/i.test(t)) return 'QC Rejected'; // alias
      return t; // Pending, Sent, Ready, Failed, Need Scale,...
    };

    // ==== matchStage (Order-level) ====
    const matchStage = {};

    // date range
    if (from && to) {
      matchStage.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    // scale_overall_status filter
    let needFilterPendingItems = false; // chỉ lọc items Pending khi đang xem Pending
    if (scale_status && String(scale_status).trim() !== '') {
      if (/^all$/i.test(scale_status.trim())) {
        matchStage.scale_overall_status = { $in: ['Need Scale', 'Pending', 'Sent', 'QC Rejected', 'Ready'] };
      } else {
        const wanted = scale_status.split(',').map(canon).filter(Boolean);
        const valid = wanted.filter(v => KNOWN.includes(v));
        if (valid.length > 0) {
          matchStage.scale_overall_status = { $in: valid };
          // nếu chỉ xem đúng Pending thì mới lọc items Pending
          needFilterPendingItems = (valid.length === 1 && valid[0] === 'Pending');
        } else {
          // ép không có kết quả nếu tham số không hợp lệ
          matchStage.scale_overall_status = { $in: ['__NO_MATCH__'] };
        }
      }
    } else {
      // Mặc định: All = Pending + Sent + QC Rejected + Ready + Failed
      matchStage.scale_overall_status = { $in: ['Need Scale', 'Pending', 'Sent', 'QC Rejected', 'Ready'] };
      needFilterPendingItems = false; // không cần lọc item pending riêng
    }

    // --- search mở rộng ---
    let searchOr = null;
    if (search && search.trim() !== '') {
      const keyword = new RegExp(search.trim(), 'i');
      searchOr = [
        { orderId: keyword },
        { 'items.sku': keyword },
        { 'items.orderItemId': keyword },
        { 'customer_infor.email': keyword },
        { 'customer_infor.name': keyword }
      ];
    }

    const pipeline = [
      // 1) Bắt đầu từ Order
      { $match: matchStage },

      // 2) Join Shop
      {
        $lookup: {
          from: 'shops',
          localField: 'shopId',
          foreignField: '_id',
          as: 'shop'
        }
      },
      { $unwind: { path: '$shop', preserveNullAndEmptyArrays: true } },

      // 3) Filter theo shopName nếu có
      ...(shopName && shopName.trim() !== ''
        ? [{ $match: { 'shop.name': { $regex: new RegExp(shopName.trim(), 'i') } } }]
        : []),

      // 4) Join Case (nhiều)
      {
        $lookup: {
          from: 'cases',
          localField: 'case',
          foreignField: '_id',
          as: 'case'
        }
      },

      // 5) Áp dụng search nếu có
      ...(searchOr ? [{ $match: { $or: searchOr } }] : [])
    ];

    // 6) (tùy chọn) Chỉ giữ lại các items có scale_status = "Pending" để QC (khi đang xem Pending)
    if (needFilterPendingItems) {
      pipeline.push({
        $addFields: {
          items: {
            $filter: {
              input: '$items',
              as: 'it',
              cond: { $eq: ['$$it.scale_status', 'Pending'] }
            }
          }
        }
      });
      // 7) Đảm bảo đơn còn ít nhất 1 item Pending sau khi filter
      pipeline.push({ $match: { $expr: { $gt: [{ $size: '$items' }, 0] } } });
    }

    // --- Count ---
    const countPipeline = [...pipeline, { $count: 'total' }];
    const countResult = await OrderCustomProduct.aggregate(countPipeline);
    const totalCount = countResult[0]?.total || 0;

    // --- Paginate ---
    const isAll = String(perPage).toLowerCase() === 'all';
    const skip = (parseInt(page) - 1) * parseInt(perPage);
    const limit = parseInt(perPage);

    pipeline.push({ $sort: { createdAt: -1 } });
    if (!isAll) pipeline.push({ $skip: skip }, { $limit: limit });

    // --- Query ---
    const orders = await OrderCustomProduct.aggregate(pipeline);

    // === Thu thập tất cả vendorProductId từ cost_breakdown của items ===
    const vendorIdSet = new Set();
    for (const o of orders) {
      for (const it of (o.items || [])) {
        const vId = it?.cost_breakdown?.vendorProductId;
        if (vId) vendorIdSet.add(String(vId));
      }
    }

    // === Lấy map: vendorProductId -> "Vendor Name - Product Name" ===
    let vendorFullNameMap = new Map();
    if (vendorIdSet.size > 0) {
      const idObjs = [];
      for (const id of vendorIdSet) {
        if (mongoose.Types.ObjectId.isValid(id)) {
          idObjs.push(new mongoose.Types.ObjectId(id));
        }
      }

      if (idObjs.length > 0) {
        const vps = await VendorProduct.find({ _id: { $in: idObjs } })
          .select('product_name vendor_id')
          .populate({ path: 'vendor_id', select: 'name' })
          .lean();

        vendorFullNameMap = new Map(
          (vps || []).map(vp => {
            const vendorName = vp?.vendor_id?.name || '';
            const productName = vp?.product_name || '';
            return [String(vp._id), `${vendorName} - ${productName}`.trim()];
          })
        );
      }
    }

    // --- Shape output ---
    const result = orders.map(order => {
      const items = (order.items || []).map(item => {
        const surfaces = item.version3Data?.customizationInfo?.surfaces || [];
        const version3Data = surfaces.flatMap(surface =>
          (surface.areas || []).map(area => ({
            label: area.label || area.name || '',
            value: area.optionValue || area.text || ''
          }))
        );

        const vendorProductId = item?.cost_breakdown?.vendorProductId || null;
        const vendorProductDisplayName = vendorProductId
          ? (vendorFullNameMap.get(String(vendorProductId)) || null)
          : null;

        return {
          orderItemId: item.orderItemId || null,
          sku: item.sku,
          title: item.title || '',
          quantity: item.quantity || 1,
          version3Data,
          baseImageUrl: item.baseImage?.imageUrl || null,
          snapshotImage: item.snapshotImage,
          totalCustomizationPrice: item.totalCustomizationPrice || 0,
          asin: item.asin,
          customized_url: item.customized_url,
          cost_center: {
            vendorProductId,
            vendorProductDisplayName,
            sizeValue: item?.cost_breakdown?.sizeValue || null,
            colorValue: item?.cost_breakdown?.colorValue || null
          },
          tracking_info: {
            fulfillment: item?.tracking_info?.fulfillment,
            status: item?.tracking_info?.status,
            tracking: item?.tracking_info?.tracking,
            note: item?.tracking_info?.note
          },
          fulfillment_file: item.fulfillment_file,
          scale_status: item.scale_status,
          qc_note: item.qc_note
        };
      });

      return {
        orderId: order.orderId,
        merchantId: order.merchantId || null,
        marketplaceId: order.marketplaceId || null,
        customer_infor: order.customer_infor,
        status: order.status || '',
        customized_url: order.customized_url,
        purchase_date: order.purchase_date,
        createdAt: order.createdAt,
        shopName: order.shop?.name || null,
        shipping_type: order.shipping_type || null,
        items,
        base_cost: order.base_cost,
        case: order.case,
        address_validation: order.address_validation?.isValid,
        scale_overall_status: order.scale_overall_status
      };
    });

    res.json({
      data: result,
      totalCount,
      totalPages: isAll ? 1 : Math.ceil(totalCount / limit),
      currentPage: parseInt(page)
    });

  } catch (error) {
    console.error('❌ getScaleList error:', error);
    res.status(500).json({
      message: 'Failed to retrieve scale list',
      error: error.message
    });
  }
};

const getScaleStatistics = async (req, res) => {
  try {
    const {
      from,
      to,
      search,
      shopName,
      breakdown,
      timeseries = 'false'
    } = req.query;

    // --- Match theo Order ---
    const matchStage = {};
    if (from && to) {
      matchStage.createdAt = {
        $gte: new Date(from),
        $lte: new Date(to)
      };
    }

    // --- Search mở rộng ---
    let searchOr = null;
    if (search && search.trim() !== '') {
      const keyword = new RegExp(search.trim(), 'i');
      searchOr = [
        { orderId: keyword },
        { 'items.sku': keyword },
        { 'items.orderItemId': keyword },
        { 'customer_infor.email': keyword },
        { 'customer_infor.name': keyword }
      ];
    }

    const KNOWN = ['Need Scale', 'Pending', 'Ready', 'Sent', 'Failed', 'QC Rejected'];

    // === Base pipeline (cấp Order) ===
    const basePipeline = [
      { $match: matchStage },

      // Join Shop để filter/breakdown
      {
        $lookup: {
          from: 'shops',
          localField: 'shopId',
          foreignField: '_id',
          as: 'shop'
        }
      },
      { $unwind: { path: '$shop', preserveNullAndEmptyArrays: true } },

      ...(shopName && shopName.trim()
        ? [{ $match: { 'shop.name': { $regex: new RegExp(shopName.trim(), 'i') } } }]
        : []),

      ...(searchOr ? [{ $match: { $or: searchOr } }] : []),

      // Chuẩn hóa bucket trạng thái ở cấp Order
      {
        $addFields: {
          overall_status_bucket: {
            $let: {
              vars: {
                s: { $ifNull: ['$scale_overall_status', 'Need Scale'] }
              },
              in: {
                $cond: [{ $in: ['$$s', KNOWN] }, '$$s', 'Other']
              }
            }
          }
        }
      }
    ];

    // === OVERALL: đếm số ORDER theo trạng thái ===
    const overallPipeline = [
      ...basePipeline,
      {
        $group: {
          _id: '$overall_status_bucket',
          orders: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: null,
          byStatus: { $push: { k: '$_id', v: '$orders' } },
          totalOrders: { $sum: '$orders' }
        }
      },
      {
        $project: {
          _id: 0,
          totalOrders: 1,
          counts: { $arrayToObject: '$byStatus' }
        }
      }
    ];

    // === BREAKDOWN THEO SHOP (nếu cần) ===
    const breakdownPipeline = [
      ...basePipeline,
      {
        $group: {
          _id: { shopName: '$shop.name', status: '$overall_status_bucket' },
          orders: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: '$_id.shopName',
          byStatus: { $push: { k: '$_id.status', v: '$orders' } },
          totalOrders: { $sum: '$orders' }
        }
      },
      {
        $project: {
          _id: 0,
          shopName: '$_id',
          totalOrders: 1,
          counts: { $arrayToObject: '$byStatus' }
        }
      },
      { $sort: { shopName: 1 } }
    ];

    // === TIME SERIES THEO NGÀY (nếu cần) ===
    const timeseriesPipeline = [
      ...basePipeline,
      {
        $addFields: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
        }
      },
      {
        $group: {
          _id: { day: '$day', status: '$overall_status_bucket' },
          orders: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: '$_id.day',
          byStatus: { $push: { k: '$_id.status', v: '$orders' } },
          totalOrders: { $sum: '$orders' }
        }
      },
      {
        $project: {
          _id: 0,
          day: '$_id',
          totalOrders: 1,
          counts: { $arrayToObject: '$byStatus' }
        }
      },
      { $sort: { day: 1 } }
    ];

    const [overallRaw] = await OrderCustomProduct.aggregate(overallPipeline);

    // Chuẩn hóa đủ key trạng thái
    const normalizeCounts = (c = {}) => {
      const counts = {
        'Need Scale': c['Need Scale'] || 0,
        'Pending': c['Pending'] || 0,
        'Ready': c['Ready'] || 0,         // Ready = all items Complete
        'Sent': c['Sent'] || 0,
        'Failed': c['Failed'] || 0,
        'QC Rejected': c['QC Rejected'] || 0,
        'Other': c['Other'] || 0
      };

      // Thêm All = tổng Pending + Sent + QC Rejected + Ready
      counts['All'] = counts['Pending'] + counts['Sent'] + counts['QC Rejected'] + counts['Ready'];

      return counts;
    };

    const overall = {
      totalOrders: overallRaw?.totalOrders || 0,
      counts: normalizeCounts(overallRaw?.counts)
    };

    let breakdownResult = [];
    if (breakdown === 'shop') {
      breakdownResult = await OrderCustomProduct.aggregate(breakdownPipeline);
      breakdownResult = breakdownResult.map(r => ({
        shopName: r.shopName || '(No shop)',
        totalOrders: r.totalOrders || 0,
        counts: normalizeCounts(r.counts)
      }));
    }

    let timeseriesResult = [];
    if (String(timeseries).toLowerCase() === 'true') {
      timeseriesResult = await OrderCustomProduct.aggregate(timeseriesPipeline);
      timeseriesResult = timeseriesResult.map(d => ({
        day: d.day,
        totalOrders: d.totalOrders || 0,
        counts: normalizeCounts(d.counts)
      }));
    }

    return res.json({
      overall,
      breakdown: breakdownResult,
      timeseries: timeseriesResult
    });
  } catch (error) {
    console.error('❌ getScaleStatistics error:', error);
    return res.status(500).json({
      message: 'Failed to retrieve scale statistics by scale_overall_status',
      error: error.message
    });
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
  updateCSNoteForItem,
  getScaleList,
  getScaleStatistics
};
