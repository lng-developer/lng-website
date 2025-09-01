// utils/wasabi.js
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const WASABI_REGION = process.env.WASABI_REGION;
const WASABI_ENDPOINT = process.env.WASABI_ENDPOINT;
const WASABI_KEY = process.env.WASABI_ACCESS_KEY_ID;
const WASABI_SECRET = process.env.WASABI_SECRET_ACCESS_KEY;
const WASABI_BUCKET = process.env.WASABI_BUCKET;
const WASABI_PUBLIC = process.env.WASABI_PUBLIC === 'true';

const s3 = new S3Client({
    region: WASABI_REGION,
    endpoint: WASABI_ENDPOINT,
    forcePathStyle: false,
    credentials: { accessKeyId: WASABI_KEY, secretAccessKey: WASABI_SECRET }
});

function buildPsdKeyFromAsin(asin) {
    const safe = String(asin).replace(/[^A-Za-z0-9_.-]/g, '_');
    return `psd/${safe}/${asin}.psd`;          // ✅ thống nhất key
}

async function uploadBufferToWasabi(buffer, { key, contentType = 'application/octet-stream' } = {}) {
    await s3.send(new PutObjectCommand({
        Bucket: process.env.WASABI_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType
    }));
    const url = `${process.env.WASABI_ENDPOINT.replace('https://', `https://${process.env.WASABI_BUCKET}.`)}/${encodeURI(key)}`;
    return { key, url };
}

async function objectExists(key) {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: process.env.WASABI_BUCKET, Key: key }));
        return true;
    } catch (e) {
        if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return false;
        throw e;
    }
}

async function getSignedUrlForKey(key, { expiresIn = 3600, asAttachment = false, filename } = {}) {
    const cmd = new GetObjectCommand({
        Bucket: process.env.WASABI_BUCKET,
        Key: key,
        ...(asAttachment ? { ResponseContentDisposition: `attachment${filename ? `; filename="${filename.replace(/"/g, '')}"` : ''}` } : {})
    });
    return await getSignedUrl(s3, cmd, { expiresIn });
}

module.exports = { s3, uploadBufferToWasabi, getSignedUrlForKey, objectExists, buildPsdKeyFromAsin };
