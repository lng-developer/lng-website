// controllers/orderFulfillment.controller.js
const multer = require('multer');
const db = require('../models');
const OrderCustomProduct = db.orderCustomProduct
const cloudinary = require('../utils/cloudinary');

const upload = multer({ storage: multer.memoryStorage() });

function uploadStreamToCloudinary(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'image', overwrite: true, ...opts },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

const uploadFulfillmentFileForItem = [
  upload.single('file'),
  async (req, res) => {
    try {
      const { orderId, orderItemId } = req.params;
      if (!req.file) return res.status(400).json({ message: 'Missing file' });

      const order = await OrderCustomProduct.findOne({ orderId });
      if (!order) return res.status(404).json({ message: 'Order not found' });

      const itemIndex = order.items.findIndex(i => i.orderItemId === orderItemId);
      if (itemIndex === -1) return res.status(404).json({ message: 'Order item not found' });

      const public_id = `fulfillment_files/${orderId}-${orderItemId}`;
      const up = await uploadStreamToCloudinary(req.file.buffer, { public_id });

      order.items[itemIndex].fulfillment_file = up.secure_url; // chỉ lưu URL
      await order.save();

      return res.json({
        message: 'Uploaded fulfillment file successfully',
        url: up.secure_url
      });
    } catch (err) {
      return res.status(500).json({ message: 'Upload failed', error: err.message });
    }
  }
];

module.exports = { uploadFulfillmentFileForItem };
