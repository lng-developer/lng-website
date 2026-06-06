const axios = require("axios");
const crypto = require("crypto");
const net = require("net");
const db = require("../models");
const { uploadBufferToR2 } = require("./cloudflareR2/r2.service");

const EtsyOrder = db.EtsyOrder;

const CUSTOM_FILE_DOWNLOAD_TIMEOUT_MS = Number(process.env.ETSY_CUSTOM_FILE_DOWNLOAD_TIMEOUT_MS || 30000);
const CUSTOM_FILE_MAX_BYTES = Number(process.env.ETSY_CUSTOM_FILE_MAX_BYTES || 25000000);
const ALLOWED_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
    "application/octet-stream",
]);
const DEFAULT_ALLOWED_HOSTS = ["etsy.com", "www.etsy.com", "i.etsystatic.com", "*.etsystatic.com"];

function maskUrlForLog(url) {
    const text = String(url || "").trim();
    if (!text) return "";
    try {
        const parsed = new URL(text);
        parsed.search = parsed.search ? "?..." : "";
        parsed.hash = parsed.hash ? "#..." : "";
        return parsed.toString();
    } catch (_err) {
        const idx = text.indexOf("?");
        return idx === -1 ? text : `${text.slice(0, idx)}?...`;
    }
}

function getAllowedHosts() {
    const configured = String(process.env.ETSY_CUSTOM_FILE_ALLOWED_HOSTS || "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
    return configured.length ? configured : DEFAULT_ALLOWED_HOSTS;
}

function isPrivateIp(hostname) {
    const host = String(hostname || "").replace(/^\[|\]$/g, "");
    const version = net.isIP(host);
    if (!version) return false;

    if (version === 4) {
        const parts = host.split(".").map(Number);
        const [a, b] = parts;
        return (
            a === 10 ||
            a === 127 ||
            (a === 0 && b === 0) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254)
        );
    }

    const normalized = host.toLowerCase();
    return (
        normalized === "::1" ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe8") ||
        normalized.startsWith("fe9") ||
        normalized.startsWith("fea") ||
        normalized.startsWith("feb")
    );
}

function hostMatchesAllowed(hostname, pattern) {
    const host = String(hostname || "").toLowerCase();
    const allowed = String(pattern || "").toLowerCase();
    if (!allowed) return false;
    if (allowed.startsWith("*.")) {
        const suffix = allowed.slice(1);
        return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === allowed;
}

function validateCustomFileDownloadUrl(url) {
    let parsed;
    try {
        parsed = new URL(String(url || "").trim());
    } catch (_err) {
        return { ok: false, reason: "Invalid downloadUrl" };
    }

    if (parsed.protocol !== "https:") {
        return { ok: false, reason: "Blocked unsafe downloadUrl" };
    }

    const hostname = parsed.hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname) || isPrivateIp(hostname)) {
        return { ok: false, reason: "Blocked unsafe downloadUrl" };
    }

    if (net.isIP(hostname)) {
        return { ok: false, reason: "Blocked unsafe downloadUrl" };
    }

    const allowed = getAllowedHosts();
    if (!allowed.some((pattern) => hostMatchesAllowed(hostname, pattern))) {
        return { ok: false, reason: "Blocked unsafe downloadUrl" };
    }

    return { ok: true, parsed };
}

function shortHash(value) {
    const seed = String(value || `${Date.now()}-${crypto.randomUUID()}`);
    return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

function safeFileName(value = "custom-file") {
    const cleaned = String(value || "custom-file")
        .trim()
        .replace(/[^\w.\-]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return cleaned || "custom-file";
}

function buildCustomFileKey({ orderId, transactionId, fileName, etsyFileId, downloadUrl, previewUrl }) {
    const identity = etsyFileId || shortHash(downloadUrl || previewUrl || fileName);
    return [
        "custom_files",
        `etsy-${safeFileName(orderId)}-${safeFileName(transactionId)}-${safeFileName(identity)}-${safeFileName(fileName)}`,
    ].join("/");
}

function buildQuery({ orderId, shopId } = {}) {
    const query = { "items.customFiles.status": "pending_download" };
    if (orderId) query.orderId = String(orderId);
    if (shopId) query.shopId = shopId;
    return query;
}

async function downloadPendingEtsyCustomFiles({ orderId, shopId, limit = 20, dryRun = false } = {}) {
    const max = Math.max(1, Number(limit) || 20);
    const summary = {
        scannedOrders: 0,
        scannedFiles: 0,
        downloadable: 0,
        downloaded: 0,
        failed: 0,
        skipped: 0,
        blockedUnsafeUrl: 0,
        blockedTooLarge: 0,
        blockedMimeType: 0,
        dryRun: !!dryRun,
        results: [],
    };

    const orders = await EtsyOrder.find(buildQuery({ orderId, shopId }))
        .sort({ updatedAt: -1, _id: -1 })
        .limit(max)
        .exec();

    for (const order of orders) {
        summary.scannedOrders += 1;
        let orderChanged = false;

        for (const item of order.items || []) {
            for (const file of item.customFiles || []) {
                if (summary.scannedFiles >= max) break;
                if (file.status !== "pending_download") continue;

                summary.scannedFiles += 1;
                const downloadUrl = String(file.downloadUrl || "").trim();
                if (!downloadUrl) {
                    summary.skipped += 1;
                    summary.results.push({
                        orderId: order.orderId,
                        transactionId: item.transactionId,
                        fileName: file.fileName,
                        status: "skipped",
                        reason: "missing_downloadUrl",
                    });
                    if (!dryRun) {
                        file.status = "skipped";
                        file.errorMessage = "Missing downloadUrl";
                        file.updatedAt = new Date();
                        orderChanged = true;
                    }
                    continue;
                }

                const urlValidation = validateCustomFileDownloadUrl(downloadUrl);
                if (!urlValidation.ok) {
                    summary.blockedUnsafeUrl += 1;
                    summary.failed += 1;
                    summary.results.push({
                        orderId: order.orderId,
                        transactionId: item.transactionId,
                        fileName: file.fileName,
                        status: "failed",
                        errorMessage: "Blocked unsafe downloadUrl",
                        downloadUrlMasked: maskUrlForLog(downloadUrl),
                    });
                    if (!dryRun) {
                        file.status = "failed";
                        file.errorMessage = "Blocked unsafe downloadUrl";
                        file.updatedAt = new Date();
                        orderChanged = true;
                    }
                    continue;
                }

                summary.downloadable += 1;
                if (dryRun) {
                    summary.results.push({
                        orderId: order.orderId,
                        transactionId: item.transactionId,
                        fileName: file.fileName,
                        status: "pending_download",
                        downloadUrlMasked: maskUrlForLog(downloadUrl),
                    });
                    continue;
                }

                try {
                    const response = await axios.get(downloadUrl, {
                        responseType: "arraybuffer",
                        timeout: CUSTOM_FILE_DOWNLOAD_TIMEOUT_MS,
                        maxContentLength: CUSTOM_FILE_MAX_BYTES,
                        maxBodyLength: CUSTOM_FILE_MAX_BYTES,
                        validateStatus: () => true,
                    });

                    if (response.status < 200 || response.status >= 300) {
                        throw new Error(`Download failed with status ${response.status}`);
                    }

                    const contentLength = Number(response.headers?.["content-length"] || 0);
                    if (contentLength > CUSTOM_FILE_MAX_BYTES) {
                        const err = new Error("File exceeds max allowed size");
                        err.blockReason = "too_large";
                        throw err;
                    }

                    const rawMimeType = String(response.headers?.["content-type"] || file.mimeType || "application/octet-stream");
                    const mimeType = rawMimeType.split(";")[0].trim().toLowerCase() || "application/octet-stream";
                    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
                        const err = new Error("Blocked unsupported mime type");
                        err.blockReason = "mime_type";
                        throw err;
                    }

                    const buffer = Buffer.from(response.data);
                    if (buffer.length > CUSTOM_FILE_MAX_BYTES) {
                        const err = new Error("File exceeds max allowed size");
                        err.blockReason = "too_large";
                        throw err;
                    }

                    const fileName = file.fileName || "custom-file";
                    const uploaded = await uploadBufferToR2({
                        buffer,
                        originalName: fileName,
                        mimeType,
                        size: buffer.length,
                        folder: "custom_files",
                        key: buildCustomFileKey({
                            orderId: order.orderId,
                            transactionId: file.transactionId || item.transactionId,
                            fileName,
                            etsyFileId: file.etsyFileId,
                            downloadUrl: file.downloadUrl,
                            previewUrl: file.previewUrl,
                        }),
                    });

                    file.storageUrl = uploaded.url;
                    file.mimeType = file.mimeType || mimeType;
                    file.size = file.size || buffer.length;
                    file.status = "downloaded";
                    file.downloadedAt = new Date();
                    file.updatedAt = new Date();
                    file.errorMessage = "";
                    orderChanged = true;
                    summary.downloaded += 1;
                    summary.results.push({
                        orderId: order.orderId,
                        transactionId: item.transactionId,
                        fileName,
                        status: "downloaded",
                        storageUrl: uploaded.url,
                        downloadUrlMasked: maskUrlForLog(downloadUrl),
                    });
                } catch (err) {
                    const axiosSizeLimitExceeded =
                        err.code === "ERR_BAD_RESPONSE" &&
                        /maxContentLength|maxBodyLength|size/i.test(String(err.message || ""));
                    if (axiosSizeLimitExceeded) err.blockReason = "too_large";
                    if (err.blockReason === "too_large") summary.blockedTooLarge += 1;
                    if (err.blockReason === "mime_type") summary.blockedMimeType += 1;
                    file.status = "failed";
                    file.errorMessage = String(err.message || err).slice(0, 2000);
                    file.updatedAt = new Date();
                    orderChanged = true;
                    summary.failed += 1;
                    summary.results.push({
                        orderId: order.orderId,
                        transactionId: item.transactionId,
                        fileName: file.fileName,
                        status: "failed",
                        errorMessage: file.errorMessage,
                        downloadUrlMasked: maskUrlForLog(downloadUrl),
                    });
                }
            }
            if (summary.scannedFiles >= max) break;
        }

        if (orderChanged) {
            order.markModified("items");
            await order.save();
        }
        if (summary.scannedFiles >= max) break;
    }

    return summary;
}

module.exports = {
    downloadPendingEtsyCustomFiles,
    validateCustomFileDownloadUrl,
};
