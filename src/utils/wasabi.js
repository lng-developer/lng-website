// utils/wasabi.js
const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let cachedClient;
let cachedConfigKey;

function clean(value) {
    return String(value || '').trim();
}

function inferWasabiRegion(endpoint) {
    const rawEndpoint = clean(endpoint);
    if (!rawEndpoint) return '';

    try {
        const hostname = new URL(rawEndpoint).hostname;
        const match = hostname.match(/(?:^|\.)s3[.-]([a-z0-9-]+)\.wasabisys\.com$/i);
        return match ? match[1] : '';
    } catch (_err) {
        const match = rawEndpoint.match(/(?:^|\.)s3[.-]([a-z0-9-]+)\.wasabisys\.com/i);
        return match ? match[1] : '';
    }
}

function resolveWasabiConfig(env = process.env) {
    const endpoint = clean(env.WASABI_ENDPOINT);
    const accessKeyId = clean(env.WASABI_ACCESS_KEY_ID);
    const secretAccessKey = clean(env.WASABI_SECRET_ACCESS_KEY);
    const bucket = clean(env.WASABI_BUCKET);
    const region = clean(env.WASABI_REGION) || inferWasabiRegion(endpoint);

    const missing = [];
    if (!region) missing.push('WASABI_REGION');
    if (!endpoint) missing.push('WASABI_ENDPOINT');
    if (!accessKeyId) missing.push('WASABI_ACCESS_KEY_ID');
    if (!secretAccessKey) missing.push('WASABI_SECRET_ACCESS_KEY');
    if (!bucket) missing.push('WASABI_BUCKET');

    if (missing.length) {
        throw new Error(`Missing Wasabi configuration: ${missing.join(', ')}`);
    }

    return { region, endpoint, accessKeyId, secretAccessKey, bucket };
}

function getWasabiClient() {
    const config = resolveWasabiConfig();
    const configKey = JSON.stringify(config);
    if (!cachedClient || cachedConfigKey !== configKey) {
        cachedClient = new S3Client({
            region: config.region,
            endpoint: config.endpoint,
            forcePathStyle: false,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
        });
        cachedConfigKey = configKey;
    }
    return { client: cachedClient, config };
}

const s3 = {
    send(command) {
        return getWasabiClient().client.send(command);
    },
};

function buildPsdKeyFromAsin(asin) {
    const safe = String(asin).replace(/[^A-Za-z0-9_.-]/g, '_');
    return `psd/${safe}/${asin}.psd`;          // ✅ thống nhất key
}

async function uploadBufferToWasabi(buffer, { key, contentType = 'application/octet-stream' } = {}) {
    const { client, config } = getWasabiClient();
    await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType
    }));
    const url = `${config.endpoint.replace('https://', `https://${config.bucket}.`)}/${encodeURI(key)}`;
    return { key, url };
}

async function objectExists(key) {
    const { client, config } = getWasabiClient();
    try {
        await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return true;
    } catch (e) {
        if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return false;
        throw e;
    }
}

async function getSignedUrlForKey(key, { expiresIn = 3600, asAttachment = false, filename } = {}) {
    const { client, config } = getWasabiClient();
    const cmd = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ...(asAttachment ? { ResponseContentDisposition: `attachment${filename ? `; filename="${filename.replace(/"/g, '')}"` : ''}` } : {})
    });
    return await getSignedUrl(client, cmd, { expiresIn });
}

module.exports = {
    s3,
    uploadBufferToWasabi,
    getSignedUrlForKey,
    objectExists,
    buildPsdKeyFromAsin,
    inferWasabiRegion,
    resolveWasabiConfig,
};
