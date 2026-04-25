const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

const router = express.Router();

const REQUIRED_ENVS = [
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_PUBLIC_BUCKET",
  "R2_PUBLIC_BASE_URL",
];

for (const envName of REQUIRED_ENVS) {
  if (!process.env[envName] || process.env[envName].includes("PASTE_")) {
    throw new Error(`[R2_CONFIG_ERROR] Missing or invalid env: ${envName}`);
  }
}

const ALLOWED_FOLDERS = ["mockup", "listing", "thumbnail", "temp", "exports"];
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

const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function normalizeFolder(folder = "mockup") {
  const cleanFolder = String(folder).replace(/^\/+|\/+$/g, "").trim();

  if (!ALLOWED_FOLDERS.includes(cleanFolder)) {
    return "mockup";
  }

  return cleanFolder;
}

function buildKey(originalName, folder = "mockup") {
  const ext = path.extname(originalName || "").toLowerCase() || ".png";
  const safeFolder = normalizeFolder(folder);

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  return `${safeFolder}/${yyyy}/${mm}/${dd}/${crypto.randomUUID()}${ext}`;
}

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "File is required",
      });
    }

    const folder = normalizeFolder(req.body.folder || "mockup");
    const key = buildKey(req.file.originalname, folder);

    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_PUBLIC_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const url = `${process.env.R2_PUBLIC_BASE_URL}/${key}`;

    return res.json({
      success: true,
      message: "Upload successfully",
      data: {
        provider: "cloudflare-r2",
        bucket: process.env.R2_PUBLIC_BUCKET,
        key,
        url,
        folder,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
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
    const { key } = req.query;

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "key is required",
      });
    }

    const result = await r2Client.send(
      new HeadObjectCommand({
        Bucket: process.env.R2_PUBLIC_BUCKET,
        Key: key,
      })
    );

    return res.json({
      success: true,
      message: "Object exists",
      data: {
        key,
        contentType: result.ContentType,
        size: result.ContentLength,
        lastModified: result.LastModified,
        publicUrl: `${process.env.R2_PUBLIC_BASE_URL}/${key}`,
      },
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

module.exports = router;