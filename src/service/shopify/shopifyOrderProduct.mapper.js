const {
    buildCustomization,
    extractCustomFiles,
} = require("./shopifyImage.service");

function extractShopifyNumericId(gid) {
    const text = String(gid || "").trim();
    if (!text) return "";
    const parts = text.split("/");
    const last = parts[parts.length - 1] || "";
    return last.split("?")[0] || text;
}

function cleanString(value) {
    return value === null || value === undefined ? "" : String(value);
}

function cloneMoneySet(value = {}) {
    return {
        amount: cleanString(value.amount),
        currencyCode: cleanString(value.currencyCode),
        shopAmount: cleanString(value.shopAmount),
        shopCurrencyCode: cleanString(value.shopCurrencyCode),
    };
}

function pickImageUrl(item = {}) {
    return cleanString(
        item.productImage?.url ||
        item.imageUrl ||
        item.img ||
        item.variantImageUrl ||
        item.productImageUrl ||
        item.image?.url ||
        item.variant?.image?.url ||
        item.variant?.product?.featuredImage?.url ||
        item.product?.featuredImage?.url
    );
}

function cloneShopifyImage(image = {}) {
    return {
        url: cleanString(image.url),
        altText: cleanString(image.altText),
        width: Number(image.width || 0),
        height: Number(image.height || 0),
        source: cleanString(image.source),
    };
}

function buildSkuInfo(item = {}, lineItemId = "") {
    return {
        sku: cleanString(item.sku),
        variantSku: cleanString(item.variantSku || item.variant?.sku || item.sku),
        productId: extractShopifyNumericId(item.productId || item.variant?.product?.id || item.product?.id),
        productGid: cleanString(item.productId || item.variant?.product?.id || item.product?.id),
        productTitle: cleanString(item.productTitle || item.variant?.product?.title || item.product?.title),
        productHandle: cleanString(item.productHandle || item.variant?.product?.handle || item.product?.handle),
        productVendor: cleanString(item.productVendor || item.variant?.product?.vendor || item.product?.vendor),
        productType: cleanString(item.productType || item.variant?.product?.productType || item.product?.productType),
        lineItemId,
        lineItemGid: cleanString(item.id),
    };
}

function buildVariantInfo(item = {}) {
    const variantGid = cleanString(item.variantId || item.variant?.id);
    return {
        variantId: extractShopifyNumericId(variantGid),
        variantGid,
        title: cleanString(item.variantTitle || item.variant?.title),
        sku: cleanString(item.variantSku || item.variant?.sku || item.sku),
        barcode: cleanString(item.variantBarcode || item.variant?.barcode),
        price: cleanString(item.variantPrice || item.variant?.price),
        selectedOptions: Array.isArray(item.selectedOptions || item.variant?.selectedOptions)
            ? (item.selectedOptions || item.variant.selectedOptions).map((option) => ({
                name: cleanString(option.name),
                value: cleanString(option.value),
            }))
            : [],
    };
}

function cloneCustomer(customer = null) {
    if (!customer) return null;
    return {
        id: cleanString(customer.id),
        email: cleanString(customer.email),
        phone: cleanString(customer.phone),
        firstName: cleanString(customer.firstName),
        lastName: cleanString(customer.lastName),
        displayName: cleanString(customer.displayName),
    };
}

function cloneShippingAddress(address = null) {
    if (!address) return null;
    return {
        name: cleanString(address.name),
        firstName: cleanString(address.firstName),
        lastName: cleanString(address.lastName),
        company: cleanString(address.company),
        address1: cleanString(address.address1),
        address2: cleanString(address.address2),
        city: cleanString(address.city),
        province: cleanString(address.province),
        provinceCode: cleanString(address.provinceCode),
        zip: cleanString(address.zip),
        country: cleanString(address.country),
        countryCode: cleanString(address.countryCode),
        phone: cleanString(address.phone),
    };
}

function mapShopifyLineItem(item = {}) {
    const imageUrl = pickImageUrl(item);
    const lineItemId = extractShopifyNumericId(item.id);
    const productImage = cloneShopifyImage(item.productImage || {
        url: imageUrl,
        source: imageUrl ? "legacy_image_url" : "",
    });
    const customization = buildCustomization(item.customAttributes);
    return {
        shopifyLineItemGid: cleanString(item.id),
        shopifyLineItemId: lineItemId,
        name: cleanString(item.name),
        title: cleanString(item.title),
        sku: cleanString(item.sku),
        quantity: Number(item.quantity || 0),
        variantTitle: cleanString(item.variantTitle),
        img: imageUrl,
        imageUrl,
        variantImageUrl: cleanString(item.variantImageUrl || item.variant?.image?.url),
        productImageUrl: cleanString(item.productImageUrl || item.variant?.product?.featuredImage?.url || item.product?.featuredImage?.url),
        productImage,
        skuInfo: buildSkuInfo(item, lineItemId),
        variantInfo: buildVariantInfo(item),
        customization,
        originalUnitPrice: cloneMoneySet(item.originalUnitPrice || {}),
        customAttributes: Array.isArray(item.customAttributes)
            ? item.customAttributes.map((attr) => ({
                key: cleanString(attr.key),
                value: cleanString(attr.value),
                source: "shopify_line_item_custom_attributes",
            }))
            : [],
        customFiles: customization.files.length ? customization.files : extractCustomFiles(item.customAttributes),
        rawLineItem: item,
    };
}

function mapShopifyOrderToOrderProductShopify(order = {}, options = {}) {
    const shopDomain = cleanString(options.shopDomain || process.env.SHOPIFY_SHOP_DOMAIN).trim();
    const shopifyOrderId = extractShopifyNumericId(order.id);
    const fulfillmentOrderId = Array.isArray(order.fulfillmentOrders)
        ? cleanString(order.fulfillmentOrders[0]?.id)
        : "";
    const now = new Date();

    return {
        platform: "shopify",
        shopDomain,
        shopifyOrderGid: cleanString(order.id),
        shopifyOrderId,
        shopifyOrderName: cleanString(order.name),
        duplicateKey: `${shopDomain}:${shopifyOrderId}`,
        financialStatus: cleanString(order.displayFinancialStatus),
        fulfillmentStatus: cleanString(order.displayFulfillmentStatus),
        fulfillmentOrderId,
        purchaseDate: order.createdAt ? new Date(order.createdAt) : null,
        updatedAtShopify: order.updatedAt ? new Date(order.updatedAt) : null,
        email: cleanString(order.email),
        phone: cleanString(order.phone),
        customer: cloneCustomer(order.customer),
        shippingAddress: cloneShippingAddress(order.shippingAddress),
        totalPrice: cloneMoneySet(order.totalPrice || {}),
        items: Array.isArray(order.lineItems) ? order.lineItems.map(mapShopifyLineItem) : [],
        rawShopifyOrder: order,
        importStatus: "imported",
        processStatus: "New",
        lastImportAt: now,
    };
}

module.exports = {
    extractShopifyNumericId,
    mapShopifyOrderToOrderProductShopify,
};
