const path = require("path");
const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

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

const ALLOWED_FOLDERS = [
  "mockup",
  "listing",
  "thumbnail",
  "temp",
  "exports",
  "fulfillment_files",
];

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

function getExtFromFile(originalName, mimeType) {
  const ext = path.extname(originalName || "").toLowerCase();

  if (ext) return ext;

  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";

  return ".png";
}

function buildKey(originalName, folder = "mockup", mimeType) {
  const ext = getExtFromFile(originalName, mimeType);
  const safeFolder = normalizeFolder(folder);

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  return `${safeFolder}/${yyyy}/${mm}/${dd}/${crypto.randomUUID()}${ext}`;
}

async function uploadBufferToR2({
  buffer,
  originalName,
  mimeType,
  size,
  folder = "mockup",
  key,
}) {
  if (!buffer) {
    throw new Error("Missing file buffer");
  }

  const finalFolder = normalizeFolder(folder);
  const finalKey = key || buildKey(originalName, finalFolder, mimeType);

  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_PUBLIC_BUCKET,
      Key: finalKey,
      Body: buffer,
      ContentType: mimeType || "application/octet-stream",
    })
  );

  const url = `${process.env.R2_PUBLIC_BASE_URL}/${finalKey}`;

  return {
    provider: "cloudflare-r2",
    bucket: process.env.R2_PUBLIC_BUCKET,
    key: finalKey,
    url,
    folder: finalFolder,
    mimeType,
    size,
  };
}

async function headR2Object(key) {
  if (!key) {
    throw new Error("key is required");
  }

  const result = await r2Client.send(
    new HeadObjectCommand({
      Bucket: process.env.R2_PUBLIC_BUCKET,
      Key: key,
    })
  );

  return {
    key,
    contentType: result.ContentType,
    size: result.ContentLength,
    lastModified: result.LastModified,
    publicUrl: `${process.env.R2_PUBLIC_BASE_URL}/${key}`,
  };
}

module.exports = {
  uploadBufferToR2,
  headR2Object,
  buildKey,
  normalizeFolder,
  ALLOWED_FOLDERS,
};