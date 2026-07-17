const { shopifyGraphQL } = require("../service/shopify/shopifyClient.service");
const db = require("../models");
const {
    mapShopifyOrderToOrderProductShopify,
} = require("../service/shopify/shopifyOrderProduct.mapper");

const OrderProductShopify = db.orderProductShopify;

function toBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    const text = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(text)) return true;
    if (["false", "0", "no", "n"].includes(text)) return false;
    return defaultValue;
}

function toPositiveInt(value, defaultValue) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

function toIsoDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildDateRange({ fromDate, toDate, days }) {
    const now = new Date();
    const to = toIsoDate(toDate) || now.toISOString();
    const from = toIsoDate(fromDate) || new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    return { from, to };
}

function normalizeMoneySet(moneySet = {}) {
    const presentment = moneySet.presentmentMoney || null;
    const shop = moneySet.shopMoney || null;
    return {
        amount: presentment?.amount || shop?.amount || null,
        currencyCode: presentment?.currencyCode || shop?.currencyCode || null,
        shopAmount: shop?.amount || null,
        shopCurrencyCode: shop?.currencyCode || null,
    };
}

function normalizeAddress(address = null) {
    if (!address) return null;
    return {
        name: [address.firstName, address.lastName].filter(Boolean).join(" ").trim() || address.name || "",
        firstName: address.firstName || "",
        lastName: address.lastName || "",
        company: address.company || "",
        address1: address.address1 || "",
        address2: address.address2 || "",
        city: address.city || "",
        province: address.province || "",
        provinceCode: address.provinceCode || "",
        zip: address.zip || "",
        country: address.country || "",
        countryCode: address.countryCodeV2 || "",
        phone: address.phone || "",
    };
}

function normalizeCustomer(customer = null) {
    if (!customer) return null;
    return {
        id: customer.id || "",
        email: customer.email || "",
        phone: customer.phone || "",
        firstName: customer.firstName || "",
        lastName: customer.lastName || "",
        displayName: customer.displayName || "",
    };
}

function normalizeLineItem(edge = {}) {
    const item = edge.node || edge;
    return {
        id: item.id || "",
        name: item.name || "",
        title: item.title || "",
        sku: item.sku || "",
        quantity: item.quantity || 0,
        variantTitle: item.variantTitle || "",
        customAttributes: Array.isArray(item.customAttributes)
            ? item.customAttributes.map((attr) => ({
                key: attr.key || "",
                value: attr.value || "",
            }))
            : [],
        originalUnitPrice: normalizeMoneySet(item.originalUnitPriceSet),
    };
}

function toShopifyGid(type, id) {
    if (id === null || id === undefined || id === "") return "";
    const text = String(id);
    return text.startsWith("gid://shopify/") ? text : `gid://shopify/${type}/${text}`;
}

function normalizeWebhookAddress(address = null) {
    if (!address) return null;
    return {
        name: address.name || [address.first_name, address.last_name].filter(Boolean).join(" ").trim() || "",
        firstName: address.first_name || "",
        lastName: address.last_name || "",
        company: address.company || "",
        address1: address.address1 || "",
        address2: address.address2 || "",
        city: address.city || "",
        province: address.province || "",
        provinceCode: address.province_code || "",
        zip: address.zip || "",
        country: address.country || "",
        countryCode: address.country_code || "",
        phone: address.phone || "",
    };
}

function normalizeWebhookCustomer(customer = null) {
    if (!customer) return null;
    const firstName = customer.first_name || "";
    const lastName = customer.last_name || "";
    return {
        id: toShopifyGid("Customer", customer.id),
        email: customer.email || "",
        phone: customer.phone || "",
        firstName,
        lastName,
        displayName: customer.display_name || [firstName, lastName].filter(Boolean).join(" "),
    };
}

function normalizeWebhookMoney(amount, currencyCode) {
    return {
        amount: amount === null || amount === undefined ? null : String(amount),
        currencyCode: currencyCode || null,
        shopAmount: amount === null || amount === undefined ? null : String(amount),
        shopCurrencyCode: currencyCode || null,
    };
}

function normalizeWebhookLineItem(item = {}, currencyCode = null) {
    return {
        id: toShopifyGid("LineItem", item.id),
        name: item.name || "",
        title: item.title || "",
        sku: item.sku || "",
        quantity: item.quantity || 0,
        variantTitle: item.variant_title || "",
        customAttributes: Array.isArray(item.properties)
            ? item.properties.map((property) => ({
                key: property.name || property.key || "",
                value: property.value || "",
            }))
            : [],
        originalUnitPrice: normalizeWebhookMoney(item.price, currencyCode),
    };
}

function normalizeWebhookOrder(order = {}) {
    const currencyCode = order.presentment_currency || order.currency || null;
    return {
        id: toShopifyGid("Order", order.id),
        name: order.name || "",
        createdAt: order.created_at || null,
        updatedAt: order.updated_at || null,
        displayFinancialStatus: order.financial_status || "",
        displayFulfillmentStatus: order.fulfillment_status || "",
        email: order.email || "",
        phone: order.phone || "",
        totalPrice: normalizeWebhookMoney(order.total_price, currencyCode),
        shippingAddress: normalizeWebhookAddress(order.shipping_address),
        customer: normalizeWebhookCustomer(order.customer),
        lineItems: Array.isArray(order.line_items)
            ? order.line_items.map((item) => normalizeWebhookLineItem(item, currencyCode))
            : [],
    };
}

function normalizeOrder(edge = {}) {
    const order = edge.node || edge;
    return {
        id: order.id || "",
        name: order.name || "",
        createdAt: order.createdAt || null,
        updatedAt: order.updatedAt || null,
        displayFinancialStatus: order.displayFinancialStatus || "",
        displayFulfillmentStatus: order.displayFulfillmentStatus || "",
        email: order.email || "",
        phone: order.phone || "",
        totalPrice: normalizeMoneySet(order.totalPriceSet),
        shippingAddress: normalizeAddress(order.shippingAddress),
        customer: normalizeCustomer(order.customer),
        lineItems: Array.isArray(order.lineItems?.edges)
            ? order.lineItems.edges.map(normalizeLineItem)
            : [],
    };
}

function getDefaultDryRun() {
    return toBoolean(process.env.SHOPIFY_IMPORT_DRY_RUN_DEFAULT, true);
}

function getDefaultImportDays() {
    return toPositiveInt(process.env.SHOPIFY_DEFAULT_IMPORT_DAYS, 7);
}

function buildShopifyOrdersQueryString({ from, to, includeFulfillmentStatus = true }) {
    return [
        `created_at:>=${from}`,
        `created_at:<=${to}`,
        "financial_status:paid",
    ].filter(Boolean).join(" ");
}

function buildImportSample(mapped, duplicate) {
    const address = mapped.shippingAddress || {};
    const customer = mapped.customer || {};
    return {
        duplicateKey: mapped.duplicateKey,
        shopifyOrderId: mapped.shopifyOrderId,
        shopifyOrderName: mapped.shopifyOrderName,
        itemCount: Array.isArray(mapped.items) ? mapped.items.length : 0,
        customerName: address.name || customer.displayName || [customer.firstName, customer.lastName].filter(Boolean).join(" "),
        duplicate: !!duplicate,
    };
}

async function fetchShopifyOrders(queryString) {
    return shopifyGraphQL(`
        query ShopifyOrdersImportPreview($queryString: String!) {
            orders(first: 20, reverse: true, query: $queryString) {
                edges {
                    node {
                        id
                        name
                        createdAt
                        updatedAt
                        displayFinancialStatus
                        displayFulfillmentStatus
                        email
                        phone
                        totalPriceSet {
                            shopMoney {
                                amount
                                currencyCode
                            }
                            presentmentMoney {
                                amount
                                currencyCode
                            }
                        }
                        shippingAddress {
                            name
                            firstName
                            lastName
                            company
                            address1
                            address2
                            city
                            province
                            provinceCode
                            zip
                            country
                            countryCodeV2
                            phone
                        }
                        customer {
                            id
                            email
                            phone
                            firstName
                            lastName
                            displayName
                        }
                        lineItems(first: 50) {
                            edges {
                                node {
                                    id
                                    name
                                    title
                                    sku
                                    quantity
                                    variantTitle
                                    customAttributes {
                                        key
                                        value
                                    }
                                    originalUnitPriceSet {
                                        shopMoney {
                                            amount
                                            currencyCode
                                        }
                                        presentmentMoney {
                                            amount
                                            currencyCode
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `, { queryString });
}

async function fetchShopifyOrdersWithFallback({ from, to }) {
    const fullQuery = buildShopifyOrdersQueryString({ from, to, includeFulfillmentStatus: true });
    try {
        const data = await fetchShopifyOrders(fullQuery);
        return { data, queryString: fullQuery, usedFallback: false };
    } catch (err) {
        const message = String(err.message || "");
        if (!/fulfillment_status|query|parse|syntax/i.test(message)) throw err;

        const fallbackQuery = buildShopifyOrdersQueryString({ from, to, includeFulfillmentStatus: false });
        console.warn("[SHOPIFY][ORDERPRODUCT][IMPORT] fulfillment filter fallback", {
            message: err.message,
        });
        const data = await fetchShopifyOrders(fallbackQuery);
        return { data, queryString: fallbackQuery, usedFallback: true };
    }
}

const testConnection = async (_req, res) => {
    const startedAt = Date.now();
    console.log("[SHOPIFY][TEST_CONNECTION] start");
    try {
        const data = await shopifyGraphQL(`
            query ShopifyTestConnection {
                shop {
                    id
                    name
                    myshopifyDomain
                    primaryDomain {
                        host
                    }
                }
            }
        `);

        console.log("[SHOPIFY][TEST_CONNECTION] end", {
            ok: true,
            durationMs: Date.now() - startedAt,
        });
        return res.json({ ok: true, shop: data.shop });
    } catch (err) {
        console.error("[SHOPIFY][TEST_CONNECTION] error", {
            message: err.message,
            code: err.code || null,
            durationMs: Date.now() - startedAt,
        });
        return res.status(err.httpStatus || 500).json({
            ok: false,
            message: err.message,
            code: err.code || null,
        });
    }
};

const importOrdersDryRun = async (req, res) => {
    const startedAt = Date.now();
    const body = req.body || {};
    const dryRun = toBoolean(body.dryRun, getDefaultDryRun());
    const days = toPositiveInt(body.days, getDefaultImportDays());
    const { from, to } = buildDateRange({
        fromDate: body.fromDate,
        toDate: body.toDate,
        days,
    });

    console.log("[SHOPIFY][ORDERPRODUCT][IMPORT] start", {
        dryRun,
        days,
        fromDate: from,
        toDate: to,
    });

    try {
        const { data, queryString } = await fetchShopifyOrdersWithFallback({ from, to });

        const orders = Array.isArray(data.orders?.edges)
            ? data.orders.edges.map(normalizeOrder)
            : [];
        const mappedOrders = orders.map((order) => mapShopifyOrderToOrderProductShopify(order, {
            shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
        }));
        console.log("[SHOPIFY][ORDERPRODUCT][MAP]", {
            totalFetched: orders.length,
            mapped: mappedOrders.length,
        });

        const duplicateKeys = mappedOrders.map((order) => order.duplicateKey).filter(Boolean);
        const duplicateDocs = duplicateKeys.length
            ? await OrderProductShopify.find({ duplicateKey: { $in: duplicateKeys } }).select("_id duplicateKey").lean()
            : [];
        const duplicateKeySet = new Set(duplicateDocs.map((doc) => doc.duplicateKey));

        let imported = 0;
        let skipped = 0;
        let failed = 0;
        const errors = [];
        const samples = mappedOrders.map((mapped) => buildImportSample(mapped, duplicateKeySet.has(mapped.duplicateKey)));

        if (!dryRun) {
            for (const mapped of mappedOrders) {
                if (duplicateKeySet.has(mapped.duplicateKey)) {
                    skipped += 1;
                    console.log("[SHOPIFY][ORDERPRODUCT][SKIP_DUPLICATE]", {
                        duplicateKey: mapped.duplicateKey,
                        shopifyOrderId: mapped.shopifyOrderId,
                        shopifyOrderName: mapped.shopifyOrderName,
                    });
                    continue;
                }

                try {
                    await OrderProductShopify.create(mapped);
                    imported += 1;
                    duplicateKeySet.add(mapped.duplicateKey);
                    console.log("[SHOPIFY][ORDERPRODUCT][DB_CREATE]", {
                        duplicateKey: mapped.duplicateKey,
                        shopifyOrderId: mapped.shopifyOrderId,
                        shopifyOrderName: mapped.shopifyOrderName,
                    });
                } catch (err) {
                    if (err?.code === 11000) {
                        skipped += 1;
                        duplicateKeySet.add(mapped.duplicateKey);
                        console.log("[SHOPIFY][ORDERPRODUCT][SKIP_DUPLICATE]", {
                            duplicateKey: mapped.duplicateKey,
                            shopifyOrderId: mapped.shopifyOrderId,
                            shopifyOrderName: mapped.shopifyOrderName,
                            reason: "E11000",
                        });
                        continue;
                    }
                    failed += 1;
                    errors.push({
                        duplicateKey: mapped.duplicateKey,
                        shopifyOrderId: mapped.shopifyOrderId,
                        shopifyOrderName: mapped.shopifyOrderName,
                        message: err.message,
                        code: err.code || null,
                    });
                }
            }
        }

        console.log("[SHOPIFY][ORDERPRODUCT][IMPORT] end", {
            ok: true,
            dryRun,
            totalFetched: orders.length,
            imported,
            skipped,
            failed,
            durationMs: Date.now() - startedAt,
        });

        return res.json({
            ok: true,
            dryRun,
            persisted: !dryRun,
            targetCollection: "orderproducshopify",
            phase: dryRun ? "shopify_orderproduct_preview" : "shopify_orderproduct_imported",
            query: {
                fromDate: from,
                toDate: to,
                days,
                shopifyQuery: queryString,
            },
            totalFetched: orders.length,
            imported,
            skipped: dryRun ? duplicateKeySet.size : skipped,
            failed,
            errors,
            samples,
            mappedOrders: dryRun ? mappedOrders.slice(0, 5) : undefined,
        });
    } catch (err) {
        console.error("[SHOPIFY][ORDERPRODUCT][IMPORT] error", {
            message: err.message,
            code: err.code || null,
            durationMs: Date.now() - startedAt,
        });
        return res.status(err.httpStatus || 500).json({
            ok: false,
            message: err.message,
            code: err.code || null,
        });
    }
};

const handleOrderCreatedWebhook = async (req, res) => {
    if (!req.body) {
        return res.status(400).json({
            ok: false,
            message: "Missing webhook payload",
        });
    }

    console.log("[SHOPIFY][WEBHOOK][ORDER_CREATE]", {
        topic: req.headers["x-shopify-topic"],
        shop: req.headers["x-shopify-shop-domain"],
        orderId: req.body.id,
        orderName: req.body.name,
    });

    const normalizedOrder = normalizeWebhookOrder(req.body);
    const mapped = mapShopifyOrderToOrderProductShopify(normalizedOrder, {
        shopDomain: req.headers["x-shopify-shop-domain"],
    });

    const duplicate = await OrderProductShopify.findOne({
        duplicateKey: mapped.duplicateKey,
    });

    if (duplicate) {
        return res.status(200).json({
            ok: true,
            duplicate: true,
            shopifyOrderId: mapped.shopifyOrderId,
            shopifyOrderName: mapped.shopifyOrderName,
        });
    }

    await OrderProductShopify.create(mapped);

    console.log("[SHOPIFY][WEBHOOK][DB_CREATE]", {
        duplicateKey: mapped.duplicateKey,
        shopifyOrderId: mapped.shopifyOrderId,
        shopifyOrderName: mapped.shopifyOrderName,
        itemCount: Array.isArray(mapped.items) ? mapped.items.length : 0,
    });

    return res.status(200).json({
        ok: true,
        imported: true,
        orderId: mapped.shopifyOrderId,
    });
};

module.exports = {
    testConnection,
    importOrdersDryRun,
    handleOrderCreatedWebhook,
    normalizeWebhookOrder,
};
