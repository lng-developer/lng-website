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
    return {
        shopifyLineItemGid: cleanString(item.id),
        shopifyLineItemId: extractShopifyNumericId(item.id),
        name: cleanString(item.name),
        title: cleanString(item.title),
        sku: cleanString(item.sku),
        quantity: Number(item.quantity || 0),
        variantTitle: cleanString(item.variantTitle),
        originalUnitPrice: cloneMoneySet(item.originalUnitPrice || {}),
        customAttributes: Array.isArray(item.customAttributes)
            ? item.customAttributes.map((attr) => ({
                key: cleanString(attr.key),
                value: cleanString(attr.value),
                source: "shopify_line_item_custom_attributes",
            }))
            : [],
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
        processStatus: "new",
        lastImportAt: now,
    };
}

module.exports = {
    extractShopifyNumericId,
    mapShopifyOrderToOrderProductShopify,
};
