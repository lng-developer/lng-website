const crypto = require("crypto");

function rejectInvalidWebhook(req, res) {
  console.error("[SHOPIFY][WEBHOOK][HMAC_FAILED]", {
    shop: req.headers["x-shopify-shop-domain"],
    topic: req.headers["x-shopify-topic"],
  });

  return res.status(401).json({
    ok: false,
    message: "Invalid Shopify webhook signature",
  });
}

function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const rawBody = req.rawBody;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!hmacHeader || !rawBody || !secret) {
    return rejectInvalidWebhook(req, res);
  }

  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const digestBuffer = Buffer.from(digest, "utf8");
  const hmacBuffer = Buffer.from(String(hmacHeader), "utf8");

  if (digestBuffer.length !== hmacBuffer.length) {
    return rejectInvalidWebhook(req, res);
  }

  if (!crypto.timingSafeEqual(digestBuffer, hmacBuffer)) {
    console.log("[SHOPIFY][HMAC_DEBUG]", {
      received: hmacHeader,
      calculated: digest,
      rawLength: req.rawBody?.length,
      contentLength: req.headers["content-length"],
    });
    return rejectInvalidWebhook(req, res);
  }

  return next();
}

module.exports = {
  verifyShopifyWebhook,
};
