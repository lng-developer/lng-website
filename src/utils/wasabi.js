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

async function uploadBufferToWasabi(buffer, opts = {}) {
    const { key, contentType = 'application/octet-stream', acl } = opts;
    await s3.send(new PutObjectCommand({
        Bucket: WASABI_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ACL: WASABI_PUBLIC ? (acl || 'public-read') : undefined
    }));
    const url = `${WASABI_ENDPOINT.replace('https://', `https://${WASABI_BUCKET}.`)}/${encodeURI(key)}`;
    return { key, url };
}

// ✅ ký URL tải xuống cho object private
async function getSignedUrlForKey(key, { expiresIn = 3600, asAttachment = false, filename } = {}) {
    const respDisposition = asAttachment
        ? `attachment${filename ? `; filename="${filename.replace(/"/g, '')}"` : ''}`
        : undefined;

    const cmd = new GetObjectCommand({
        Bucket: WASABI_BUCKET,
        Key: key,
        ...(respDisposition ? { ResponseContentDisposition: respDisposition } : {})
    });
    return await getSignedUrl(s3, cmd, { expiresIn });
}

module.exports = { s3, uploadBufferToWasabi, getSignedUrlForKey };
