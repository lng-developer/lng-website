const express = require("express");
const multer = require("multer");
const db = require("../models");
const {
    uploadBufferToR2,
    headR2Object,
} = require("../service/cloudflareR2/r2.service");

const OrderCustomProduct = db.orderCustomProduct;

const router = express.Router();

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            return cb(new Error("Only JPG, PNG, WEBP, and GIF images are allowed"));
        }

        cb(null, true);
    },
});

router.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "File is required",
            });
        }

        const result = await uploadBufferToR2({
            buffer: req.file.buffer,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
            folder: req.body.folder || "mockup",
        });

        return res.json({
            success: true,
            message: "Upload successfully",
            data: result,
        });
    } catch (error) {
        console.error("[R2_UPLOAD_ERROR]", error);

        return res.status(500).json({
            success: false,
            message: "Upload failed",
            error: error.message,
        });
    }
});

router.get("/head", async (req, res) => {
    try {
        const result = await headR2Object(req.query.key);

        return res.json({
            success: true,
            message: "Object exists",
            data: result,
        });
    } catch (error) {
        console.error("[R2_HEAD_ERROR]", error);

        return res.status(500).json({
            success: false,
            message: "Cannot get object info",
            error: error.message,
        });
    }
});

router.post(
    "/orders/:orderId/items/:orderItemId/fulfillment-files/preview",
    upload.array("files"),
    async (req, res) => {
        try {
            const { orderId, orderItemId } = req.params;
            const { meta } = req.body;

            /**
             * API này chỉ dùng để test upload fulfillment files lên Cloudflare R2.
             *
             * Important:
             * - Không update order.items.fulfillment_file.
             * - Không update item.scale_status.
             * - Không update order.scale_overall_status.
             * - Không update order.scaleId.
             * - Không ghi order history.
             * - Không ảnh hưởng API fulfillment cũ đang dùng Cloudinary.
             */

            if (!req.files?.length) {
                return res.status(400).json({
                    success: false,
                    message: "Missing files",
                });
            }

            let positions = [];

            try {
                positions = JSON.parse(meta || "[]");
            } catch {
                return res.status(400).json({
                    success: false,
                    message: "Invalid meta JSON",
                });
            }

            if (!Array.isArray(positions)) {
                return res.status(400).json({
                    success: false,
                    message: "Meta must be an array",
                });
            }

            if (positions.length !== req.files.length) {
                return res.status(400).json({
                    success: false,
                    message: "Files count not match positions",
                });
            }

            /**
             * Check order thật để test sát production context.
             * Dùng lean() vì API này chỉ đọc order, không save DB.
             */
            const order = await OrderCustomProduct.findOne({ orderId }).lean();

            if (!order) {
                return res.status(404).json({
                    success: false,
                    message: "Order not found",
                });
            }

            const item = Array.isArray(order.items)
                ? order.items.find(
                    (i) => String(i.orderItemId) === String(orderItemId)
                )
                : null;

            if (!item) {
                return res.status(404).json({
                    success: false,
                    message: "Order item not found",
                });
            }

            const previewFulfillmentFile = {};
            const uploadedFiles = [];

            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];

                const pos = String(positions[i]?.position || "")
                    .trim()
                    .toLowerCase();

                if (!pos) {
                    return res.status(400).json({
                        success: false,
                        message: `Missing position for file index ${i}`,
                    });
                }

                /**
                 * Upload file buffer lên Cloudflare R2.
                 * Folder fulfillment_files cần tồn tại trong ALLOWED_FOLDERS
                 * của r2.service.js.
                 */
                const up = await uploadBufferToR2({
                    buffer: file.buffer,
                    originalName: file.originalname,
                    mimeType: file.mimetype,
                    size: file.size,
                    folder: "fulfillment_files",
                });

                previewFulfillmentFile[pos] = up.url;

                uploadedFiles.push({
                    position: pos,
                    provider: up.provider,
                    bucket: up.bucket,
                    key: up.key,
                    url: up.url,
                    folder: up.folder,
                    mimeType: up.mimeType,
                    size: up.size,
                });
            }

            return res.json({
                success: true,
                message:
                    "R2 fulfillment preview uploaded successfully. Production order was not updated.",
                data: {
                    mode: "preview_only",
                    provider: "cloudflare-r2",

                    orderId,
                    orderItemId,
                    orderExists: true,
                    itemExists: true,

                    current_fulfillment_file: item.fulfillment_file || {},
                    preview_fulfillment_file: previewFulfillmentFile,
                    files: uploadedFiles,

                    warning:
                        "Preview only. This API does not update order.items.fulfillment_file, scale_status, scale_overall_status, scaleId, or order history.",
                },
            });
        } catch (error) {
            console.error("[R2_FULFILLMENT_PREVIEW_ERROR]", error);

            return res.status(500).json({
                success: false,
                message: "R2 fulfillment preview failed",
                error: error.message,
            });
        }
    }
);


function computeOverallScaleStatus(orderDoc) {
  const items = orderDoc.items || [];
  if (items.length === 0) return "Need Scale";

  const statuses = items.map((i) => String(i?.scale_status || "Need Scale"));

  const anyRejected = statuses.some((s) => s === "QC Rejected");
  if (anyRejected) return "QC Rejected";

  const allComplete = statuses.every((s) => s === "Complete");
  if (allComplete) return "Ready";

  const noneNeedScale = statuses.every(
    (s) => s === "Pending" || s === "Complete"
  );
  if (noneNeedScale) return "Pending";

  return "Need Scale";
}

function toPlainFulfillmentFile(ff) {
  try {
    if (!ff) return {};
    if (ff instanceof Map) return Object.fromEntries(ff);
    if (typeof ff === "object" && !Array.isArray(ff)) return ff;
    if (typeof ff === "string") return { file: ff };
    return {};
  } catch {
    return {};
  }
}

router.post(
  "/orders/:orderId/items/:orderItemId/fulfillment-files/apply",
  upload.array("files"),
  async (req, res) => {
    try {
      const { orderId, orderItemId } = req.params;
      const meta = req.body?.meta;
      const confirm = req.body?.confirm;

      /**
       * API này dùng để test R2 trên DB thật.
       *
       * Important:
       * - Có update order.items[].fulfillment_file.
       * - Có update item.scale_status = Pending.
       * - Có update order.scale_overall_status.
       * - Có save order thật.
       * - Không thay API Cloudinary cũ.
       */

      if (confirm !== "APPLY_R2_TO_ORDER") {
        return res.status(400).json({
          success: false,
          message:
            'Missing confirm. Please send confirm="APPLY_R2_TO_ORDER" to update production order.',
        });
      }

      if (!req.files?.length) {
        return res.status(400).json({
          success: false,
          message: "Missing files",
        });
      }

      let positions = [];

      try {
        positions = JSON.parse(meta || "[]");
      } catch {
        return res.status(400).json({
          success: false,
          message: "Invalid meta JSON",
        });
      }

      if (!Array.isArray(positions)) {
        return res.status(400).json({
          success: false,
          message: "Meta must be an array",
        });
      }

      if (positions.length !== req.files.length) {
        return res.status(400).json({
          success: false,
          message: "Files count not match positions",
        });
      }

      const order = await OrderCustomProduct.findOne({ orderId });

      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      const item = Array.isArray(order.items)
        ? order.items.find(
            (i) => String(i.orderItemId) === String(orderItemId)
          )
        : null;

      if (!item) {
        return res.status(404).json({
          success: false,
          message: "Order item not found",
        });
      }

      const before = {
        fulfillment_file: toPlainFulfillmentFile(item.fulfillment_file),
        item_scale_status: item.scale_status,
        order_scale_overall_status: order.scale_overall_status,
        scaleId: order.scaleId ? String(order.scaleId) : null,
      };

      const ff = item.fulfillment_file;

      if (!ff) {
        item.fulfillment_file = new Map();
      } else if (typeof ff === "string") {
        item.fulfillment_file = new Map();
      } else if (!(ff instanceof Map)) {
        item.fulfillment_file = new Map(Object.entries(ff));
      }

      const uploadedFiles = [];

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

        const pos = String(positions[i]?.position || "")
          .trim()
          .toLowerCase();

        if (!pos) {
          return res.status(400).json({
            success: false,
            message: `Missing position for file index ${i}`,
          });
        }

        const up = await uploadBufferToR2({
          buffer: file.buffer,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          folder: "fulfillment_files",
        });

        item.fulfillment_file.set(pos, up.url);

        uploadedFiles.push({
          position: pos,
          provider: up.provider,
          bucket: up.bucket,
          key: up.key,
          url: up.url,
          folder: up.folder,
          mimeType: up.mimeType,
          size: up.size,
        });
      }

      item.scale_status = "Pending";
      order.scale_overall_status = computeOverallScaleStatus(order);

      const scaleUserId = req.user?.id || req.user?.userId;
      if (scaleUserId) {
        order.scaleId = scaleUserId;
      }

      item.markModified("fulfillment_file");
      order.markModified("items");

      await order.save();

      const after = {
        fulfillment_file: toPlainFulfillmentFile(item.fulfillment_file),
        item_scale_status: item.scale_status,
        order_scale_overall_status: order.scale_overall_status,
        scaleId: order.scaleId ? String(order.scaleId) : null,
      };

      return res.json({
        success: true,
        message:
          "R2 fulfillment files applied successfully. Production order was updated.",
        data: {
          mode: "apply_to_order",
          provider: "cloudflare-r2",
          orderId,
          orderItemId,
          orderUpdated: true,
          itemUpdated: true,
          before,
          after,
          files: uploadedFiles,
          warning:
            "This API updated production order.items.fulfillment_file and scale status. Use only for controlled testing.",
        },
      });
    } catch (error) {
      console.error("[R2_FULFILLMENT_APPLY_ERROR]", error);

      return res.status(500).json({
        success: false,
        message: "R2 fulfillment apply failed",
        error: error.message,
      });
    }
  }
);
module.exports = router;