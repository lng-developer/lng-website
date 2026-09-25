// services/fulfillment/providers/lng.js
const axios = require("axios");

function splitName(full = "") {
  const name = String(full || "").trim();
  if (!name) return { firstName: "", lastName: "" };
  
  const parts = name.split(/\s+/);
  
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "." };
  }
  
  const lastName = parts.pop();
  const firstName = parts.join(" ");
  
  return { firstName, lastName };
}

function buildOrderItem(item) {
  const cost = item.cost_breakdown || {};
  
  return {
    // Match với orderItemSchema
    orderItemId: item.orderItemId || '',
    quantity: Number(item.quantity || 1),
    imageUrl: item.baseImage?.imageUrl,
    svgFile: item.svgFile || '',
    // Fulfillment files - Convert Map to Object
    fulfillment_file: item.fulfillment_file 
      ? (item.fulfillment_file instanceof Map 
          ? Object.fromEntries(item.fulfillment_file)
          : item.fulfillment_file)
      : {},
    // Cost breakdown - giữ nguyên cấu trúc
    sku: cost.matchedSku
  };
}

/**
 * Build complete payload for Order API
 * Match với createOrder req.body và Order schema
 */
function buildPayload(orderObj) {
  const customer = orderObj.customer_infor || {};
  const items = orderObj.items || [];

  // Split name để tạo fullName
  const { firstName, lastName } = splitName(customer.name || '');
  const fullName = `${firstName} ${lastName}`.trim();

  return {
    // Match với createOrder validation
    orderId: orderObj.orderId,
    
    // Items array - match với Order schema
    items: items.map(buildOrderItem),
    
    // Customer info - match với customer_infor schema
    customer_infor: {
      email: customer.email || '',
      name: fullName || customer.name || '',
      address: customer.address || customer.shipping_address1 || '',
      address_2: customer.address_2 || customer.shipping_address2 || '',
      province: customer.province || customer.shipping_province || '',
      city: customer.city || customer.shipping_city || '',
      state: customer.state || customer.shipping_province_code || '',
      zip_code: customer.zip_code || customer.shipping_zip || '',
      country: customer.country || customer.shipping_country_code || 'US',
      phone_number: customer.phone_number || customer.shipping_phone || '',
    },
    
    // Shipping type - match với enum trong schema
    shipping_type: orderObj.shipping_type || 'Standard',
  };
}

function buildPlatformPayload(orderObj, sourceChannel = "AMAZON") {
  const legacyPayload = buildPayload(orderObj);

  return {
    data: [
      {
        ...legacyPayload,
        source: "portal",
        sourceChannel: sourceChannel === "ETSY" ? "ETSY" : "AMAZON",
      },
    ],
  };
}

function getPlatformEndpoint() {
  const baseUrl = String(process.env.FULFILLMENT_API_BASE_URL || "").trim();
  if (!baseUrl) return "";
  return `${baseUrl.replace(/\/+$/, "")}/api/portal/orders`;
}

/* -------------------------- Sender ------------------------- */
async function send(orderDoc, options = {}) {
    const orderObj = orderDoc.toObject
        ? orderDoc.toObject({ getters: false, virtuals: false })
        : orderDoc;

    const platformEndpoint = getPlatformEndpoint();
    const tenantApiKey = String(process.env.FULFILLMENT_TENANT_API_KEY || "").trim();
    const usePlatform = Boolean(platformEndpoint && tenantApiKey);
    const payload = usePlatform ? buildPlatformPayload(orderObj, options.sourceChannel) : buildPayload(orderObj);
    const items = usePlatform ? payload.data?.[0]?.items : payload.items;
    if (!items?.length) {
        const err = new Error("LNG: No line items to send.");
        err.code = "NO_LINE_ITEMS";
        throw err;
    }

    const createEndpoint = usePlatform ? platformEndpoint : process.env.LNG_ENDPOINT;
    const headers = usePlatform
        ? {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tenantApiKey}`,
        }
        : {
            "Content-Type": "application/json",
            "x-api-key": process.env.LNG_API_KEY,
        };

    console.log("[LNG] Create order endpoint:", createEndpoint);
    console.log("[LNG] Sending payload:", JSON.stringify(payload, null, 2));

    // Create order
    let resp;
    try {
        resp = await axios.post(createEndpoint, payload, { headers });
    } catch (error) {
        const platformMessage =
            error?.response?.data?.error?.message ||
            error?.response?.data?.message ||
            error?.response?.data?.errors?.[0]?.message ||
            error?.message ||
            "LNG request failed";
        error.message = `LNG ${usePlatform ? "platform" : "legacy"} send failed: ${platformMessage}`;
        throw error;
    }
    const body = resp?.data;

    if (!body || typeof body !== "object") {
        const err = new Error("LNG: Empty or invalid JSON response");
        err.code = "LNG_INVALID_RESPONSE";
        throw err;
    }
    return {
        data: body,
    };
}

module.exports = {
    key: "lng",
    canHandle: (orderDoc) =>
        String(orderDoc.vendor || "").toLowerCase() === "lng",
    send,
};
