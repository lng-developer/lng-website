// src/modules/cost-engine/cost-engine.service.js
//
// Unified cost computation service.
// Extracted from orderCustomProduct.controller.js (lines 2463-3764)
// and etsyOrder.controller.js (lines 650-1052) to eliminate duplication.
//
// Both Amazon and Etsy cost calculation call into this shared service.

const db = require("../../models");
const ConfigCostCenter = db.configCostCenter;
const VendorCostCenter = db.vendorCostCenter;
const ConfigOptionMapping = db.configOptionMapping;
const VendorProduct = db.vendorProduct;
const logger = require("../../middleware/logger");

// ======================== UTILITY HELPERS ========================

function normalize(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function toArray(val) {
    if (Array.isArray(val)) return val;
    if (val == null) return [];
    return [val];
}

function parseConfigCodeFromSKU(sku = "") {
    const parts = String(sku)
        .split("-")
        .map((s) => s.trim())
        .filter(Boolean);
    return parts.length >= 2 ? parts[1] : "";
}

function pickValueByKeys(labelValueMap, keys = []) {
    for (const k of toArray(keys)) {
        const v = labelValueMap.get(normalize(k));
        if (v != null && v !== "") return v;
    }
    return "";
}

// ======================== LABEL MAPPING CONFIG ========================

/**
 * Configuration for handling combined/special label formats
 */
const labelMappings = {
    'select product type/color': {
        splitBy: '/',
        targets: ['select product type', 'color']
    },
    'product type/color': {
        splitBy: '/',
        targets: ['product type', 'color']
    },
    'color/select product type': {
        splitBy: '/',
        targets: ['color', 'select product type']
    },
    'style - size': {
        splitBy: ' - ',
        targets: ['style', 'size']
    }
};

/**
 * Process combined labels according to mapping configuration
 */
function processCombinedLabels(labelValueMap) {
    const result = new Map(labelValueMap);
    
    for (const [label, value] of labelValueMap) {
        const mapping = labelMappings[label];
        if (!mapping || !value) continue;
        
        const parts = String(value).split(mapping.splitBy);
        if (parts.length >= 2) {
            // Map each part to its target
            mapping.targets.forEach((target, index) => {
                if (index < parts.length && parts[index].trim()) {
                    result.set(target, parts[index].trim());
                }
            });
        }
    }
    
    return result;
}

// ======================== LABEL-VALUE MAP EXTRACTORS ========================

/**
 * Extract label→value map from Amazon order item.
 * Uses version3Data (priority) then fallback customizationData.
 */
function extractLabelValueMapFromAmazonItem(item) {
    const map = new Map();
    const surfacesV3 = item?.version3Data?.customizationInfo?.surfaces || [];
    for (const sf of surfacesV3) {
        for (const area of sf?.areas || []) {
            const label = area?.label || area?.name || "";
            const value = area?.optionValue ?? area?.text ?? "";
            if (label) map.set(normalize(label), String(value));
        }
    }
    if (map.size === 0) {
        const opts =
            item?.customizationData?.children?.[0]?.children?.[0]?.children || [];
        for (const opt of opts) {
            const label = opt?.label || opt?.name || "";
            let value = "";
            if (opt?.optionSelection)
                value = opt.optionSelection?.label || opt.optionSelection?.name || "";
            else if (typeof opt?.inputValue === "string") value = opt.inputValue;
            else if (opt?.displayValue) value = opt.displayValue;
            if (label) map.set(normalize(label), String(value || ""));
        }
    }
    
    // Process combined labels using enhanced mapping
    return processCombinedLabels(map);
}

/**
 * Extract label→value map from Etsy order item variations.
 * Handles special "Style - Size" combined fields.
 */
function extractLabelValueMapFromEtsyItem(item) {
    const map = new Map();
    const vars = item?.variations || {};
    for (const [label, value] of Object.entries(vars)) {
        if (!label) continue;
        const normLabel = normalize(label);
        map.set(normLabel, String(value || ""));
        if (normLabel === "style - size" && value) {
            const lastDash = String(value).lastIndexOf(" - ");
            if (lastDash > 0) {
                const stylePart = String(value).substring(0, lastDash).trim();
                const sizePart = String(value).substring(lastDash + 3).trim();
                if (!map.has("style")) map.set("style", stylePart);
                if (!map.has("size")) map.set("size", sizePart);
                if (!map.has("product type")) map.set("product type", stylePart);
            }
        }
    }
    return map;
}

// ======================== CONFIG & MAPPING ========================

/**
 * Map option value (size/color/product type) through ConfigOptionMapping rules.
 * Supports: equals, contains, regex, regex_replace match types.
 */
async function mapOptionValue({ configCode, key, rawValue }) {
    let val = String(rawValue ?? "");
    if (!val) return { value: val, ruleId: null, matchType: null };
    if (!ConfigOptionMapping)
        return { value: val, ruleId: null, matchType: null };

    const rules = await ConfigOptionMapping.find({
        config_code: configCode,
        key,
        active: { $ne: false },
    })
        .sort({ priority: 1, created_at: 1 })
        .lean();

    const n = (x) => String(x || "").trim();
    const nl = (x) => normalize(x);

    for (const r of rules || []) {
        const mt = String(r.match_type || "equals").toLowerCase();
        const flags = r.regex_flags || "i";
        const cs = !!r.case_sensitive;
        const mval = String(r.match_value ?? "");
        const mapped = String(r.mapped_value ?? "");

        try {
            if (mt === "equals") {
                const ok = cs ? n(val) === n(mval) : nl(val) === nl(mval);
                if (ok) return { value: mapped, ruleId: String(r._id), matchType: mt };
            }
            if (mt === "contains") {
                const ok = cs ? n(val).includes(n(mval)) : nl(val).includes(nl(mval));
                if (ok) return { value: mapped, ruleId: String(r._id), matchType: mt };
            }
            if (mt === "regex") {
                const re = new RegExp(mval, flags);
                if (re.test(val))
                    return { value: mapped, ruleId: String(r._id), matchType: mt };
            }
            if (mt === "regex_replace") {
                const re = new RegExp(mval, flags);
                const replaced = val.replace(re, mapped);
                if (replaced !== val)
                    return { value: replaced, ruleId: String(r._id), matchType: mt };
            }
        } catch (_e) {
            /* ignore bad regex */
        }
    }
    return { value: val, ruleId: null, matchType: null };
}

/**
 * Select the right ConfigCostCenter by product type matching.
 * Amazon version (no product-type mapping fallback).
 */
async function selectConfigByProductType(configCode, labelValueMap) {
    const cfgCandidates = await ConfigCostCenter.find({
        config_code: configCode,
        is_deleted: { $in: [false, null] },
    })
        .populate("product_for_seller")
        .lean();

    if (!cfgCandidates.length)
        return { cfg: null, reason: "No config cost center found by config_code" };

    for (const c of cfgCandidates) {
        const typeValRaw = pickValueByKeys(
            labelValueMap,
            c.customize_product_type_key || []
        );
        const typeVal = normalize(typeValRaw);
        const sellerName = normalize(c?.product_for_seller?.name || "");
        if (typeVal && sellerName && typeVal === sellerName) {
            return {
                cfg: c,
                productTypeValue: typeValRaw,
                matchedBy: "product_type_exact",
            };
        }
    }

    if (cfgCandidates.length === 1) {
        const only = cfgCandidates[0];
        const typeValRaw = pickValueByKeys(
            labelValueMap,
            only.customize_product_type_key || []
        );
        return {
            cfg: only,
            productTypeValue: typeValRaw,
            matchedBy: "single_candidate_fallback",
        };
    }

    return {
        cfg: null,
        reason: "Multiple configs; cannot determine by product type key/value",
    };
}

/**
 * Etsy-enhanced version of selectConfigByProductType.
 * Includes product-type mapping fallback + partial match.
 */
async function selectConfigByProductTypeEtsy(configCode, labelValueMap, cachedMapOption = null) {
    const cfgCandidates = await ConfigCostCenter.find({
        config_code: configCode,
        is_deleted: { $in: [false, null] },
    })
        .populate("product_for_seller")
        .lean();

    if (!cfgCandidates.length)
        return { cfg: null, reason: "No config cost center found by config_code" };

    let mappedProductTypeInfo = null;

    for (const c of cfgCandidates) {
        let typeValRaw = pickValueByKeys(
            labelValueMap,
            c.customize_product_type_key || []
        );

        // Etsy fallback: try "product type" if customize key not found
        if (!typeValRaw && labelValueMap.has("product type")) {
            typeValRaw = labelValueMap.get("product type");
        }

        let typeValToMatch = normalize(typeValRaw);

        // Try mapping product type variant
        if (typeValRaw && cachedMapOption && !mappedProductTypeInfo) {
            mappedProductTypeInfo = await cachedMapOption({
                configCode,
                key: "product type",
                rawValue: typeValRaw,
            });
        }

        if (
            mappedProductTypeInfo &&
            mappedProductTypeInfo.value &&
            normalize(mappedProductTypeInfo.value) !== typeValToMatch
        ) {
            typeValToMatch = normalize(mappedProductTypeInfo.value);
        }

        const sellerName = normalize(c?.product_for_seller?.name || "");
        if (typeValToMatch && sellerName && typeValToMatch === sellerName) {
            return {
                cfg: c,
                productTypeValue: typeValRaw,
                matchedBy: mappedProductTypeInfo?.matchType
                    ? "product_type_mapped"
                    : "product_type_exact",
            };
        }
    }

    if (cfgCandidates.length === 1) {
        const only = cfgCandidates[0];
        const typeValRaw = pickValueByKeys(
            labelValueMap,
            only.customize_product_type_key || []
        );
        return {
            cfg: only,
            productTypeValue: typeValRaw,
            matchedBy: "single_candidate_fallback",
        };
    }

    // Partial match fallback
    const partialMatches = [];
    for (const c of cfgCandidates) {
        const typeValRaw = pickValueByKeys(
            labelValueMap,
            c.customize_product_type_key || []
        );
        const typeVal = normalize(typeValRaw);
        const sellerName = normalize(c?.product_for_seller?.name || "");
        if (typeVal && sellerName && sellerName.includes(typeVal)) {
            partialMatches.push({ cfg: c, typeValRaw });
        }
    }

    if (partialMatches.length === 1) {
        return {
            cfg: partialMatches[0].cfg,
            productTypeValue: partialMatches[0].typeValRaw,
            matchedBy: "product_type_partial_match",
        };
    }

    return {
        cfg: null,
        reason: `Multiple configs (${cfgCandidates.length}) - partial matches (${partialMatches.length}); cannot determine`,
    };
}

// ======================== VENDOR MATCHING ========================

/** Match size/color against VendorCostCenter candidates. */
function findBestCostCenter(
    candidates,
    sizeValue,
    colorValue,
    { strict = true } = {}
) {
    const norm = (s) =>
        String(s || "")
            .toLowerCase()
            .trim();
    const sizeN = norm(sizeValue);
    const colorN = norm(colorValue);
    const hit = candidates.find(
        (c) => norm(c.vendor_size) === sizeN && norm(c.vendor_color) === colorN
    );
    if (hit) return hit;
    if (strict) return null;
    return null;
}

/** Resolve vendorId from a VendorProduct document. */
async function getVendorIdByVendorProductId(vendorProductId) {
    if (!vendorProductId) return null;
    const vp = await VendorProduct.findById(vendorProductId)
        .select("vendor_id")
        .lean();
    return vp?.vendor_id ? String(vp.vendor_id) : null;
}

/** Choose preferred vendor by intersection + rank stability. */
function choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) {
    if (!candidateSetsPerItem.length) return null;

    let inter = new Set(candidateSetsPerItem[0]);
    for (let i = 1; i < candidateSetsPerItem.length; i++) {
        const cur = candidateSetsPerItem[i];
        inter = new Set([...inter].filter((v) => cur.has(v)));
        if (inter.size === 0) break;
    }
    if (!inter.size) return null;

    let best = null;
    let bestRank = Infinity;
    for (const vId of inter) {
        const r = vendorRank.get(String(vId)) ?? 999;
        if (r < bestRank || (r === bestRank && String(vId) < String(best))) {
            best = vId;
            bestRank = r;
        }
    }
    return best;
}

// ======================== QUERY CACHE FACTORY ========================

/**
 * Creates in-memory caches for a single cost-compute-for-order call.
 * Avoids re-querying DB for the same configCode/vendorProduct during one request.
 */
function createCacheContext(opts = {}) {
    const _cfgCache = new Map();
    const _optRulesCache = new Map();
    const _vpIdCache = new Map();
    const _vccCache = new Map();
    const selectFn = opts.platform === "etsy" ? selectConfigByProductTypeEtsy : selectConfigByProductType;

    return {
        async cachedSelectConfig(configCode, labelValueMap) {
            if (_cfgCache.has(configCode)) return _cfgCache.get(configCode);
            const result = opts.platform === "etsy"
                ? await selectFn(configCode, labelValueMap, this.cachedMapOptionValue.bind(this))
                : await selectFn(configCode, labelValueMap);
            _cfgCache.set(configCode, result);
            return result;
        },

        async cachedMapOptionValue({ configCode, key, rawValue }) {
            const cacheKey = `${configCode}::${key}::${rawValue}`;
            if (_optRulesCache.has(cacheKey)) return _optRulesCache.get(cacheKey);
            const result = await mapOptionValue({ configCode, key, rawValue });
            _optRulesCache.set(cacheKey, result);
            return result;
        },

        async cachedGetVendorId(vpId) {
            const k = String(vpId);
            if (_vpIdCache.has(k)) return _vpIdCache.get(k);
            const result = await getVendorIdByVendorProductId(vpId);
            _vpIdCache.set(k, result);
            return result;
        },

        async cachedVendorCostCenters(vendorProductId) {
            const k = String(vendorProductId);
            if (_vccCache.has(k)) return _vccCache.get(k);
            const docs = await VendorCostCenter.find({
                vendor_product: vendorProductId,
                status: { $in: ["Active", "active", null] },
            })
                .select(
                    "vendor_size vendor_color standard_size standard_color base_cost sku " +
                    "international priority additional_costs"
                )
                .lean();
            _vccCache.set(k, docs);
            return docs;
        },
    };
}

// ======================== SHIPPING RATE RESOLUTION ========================

/**
 * Pick shipping profile (priority/international) from a VendorCostCenter doc.
 */
function pickShippingFromDoc(doc, preferProfile) {
    if (!doc) return null;
    const hasPriority =
        doc.priority &&
        (doc.priority.economy != null || doc.priority.additional != null);
    const hasIntl =
        doc.international &&
        (doc.international.economy != null ||
            doc.international.additional != null);

    if (preferProfile === "priority" && hasPriority) {
        return {
            eco: Number(doc.priority.economy ?? 0),
            add: Number(doc.priority.additional ?? 0),
            profile: "priority",
            source: "doc",
        };
    }
    if (hasIntl) {
        return {
            eco: Number(doc.international.economy ?? 0),
            add: Number(doc.international.additional ?? 0),
            profile: "international",
            source: "doc",
        };
    }
    return null;
}

/**
 * Resolve shipping rate for an item, with fallback chain.
 * - Expedited → priority first, then international
 * - Standard  → international
 */
async function resolveShippingRate({
    matched,
    shippingType,
    vendorProductId,
    sizeValue,
    colorValue,
    cache,
}) {
    const type = String(shippingType || "").toLowerCase();

    async function lookupFromCache(preferProfile) {
        if (!vendorProductId || !cache) return null;
        const allDocs = await cache.cachedVendorCostCenters(vendorProductId);
        const normS = String(sizeValue || "").trim().toLowerCase();
        const normC = String(colorValue || "").trim().toLowerCase();

        // vendor_size/color
        for (const doc of allDocs) {
            if (
                normS && String(doc.vendor_size || "").trim().toLowerCase() === normS &&
                normC && String(doc.vendor_color || "").trim().toLowerCase() === normC
            ) {
                const p = pickShippingFromDoc(doc, preferProfile);
                if (p) return p;
            }
        }
        // standard_size/color
        for (const doc of allDocs) {
            if (
                normS && String(doc.standard_size || "").trim().toLowerCase() === normS &&
                normC && String(doc.standard_color || "").trim().toLowerCase() === normC
            ) {
                const p = pickShippingFromDoc(doc, preferProfile);
                if (p) return p;
            }
        }
        // fallback: any doc
        for (const doc of allDocs) {
            const p = pickShippingFromDoc(doc, preferProfile);
            if (p) return p;
        }
        return null;
    }

    if (type === "expedited") {
        // 1) matched.priority
        if (
            matched?.priority &&
            (matched.priority.economy != null || matched.priority.additional != null)
        ) {
            return {
                eco: Number(matched.priority.economy ?? 0),
                add: Number(matched.priority.additional ?? 0),
                profile: "priority",
                source: "matched",
            };
        }
        // 2) DB lookup priority, fallback international
        const dbPick = await lookupFromCache("priority");
        if (dbPick) return dbPick;

        // 3) Fallback matched.international
        if (
            matched?.international &&
            (matched.international.economy != null ||
                matched.international.additional != null)
        ) {
            return {
                eco: Number(matched.international.economy ?? 0),
                add: Number(matched.international.additional ?? 0),
                profile: "international",
                source: "matched-fallback",
            };
        }
        return { eco: 0, add: 0, profile: "priority", source: "zero" };
    }

    // STANDARD / other → international
    if (
        matched?.international &&
        (matched.international.economy != null ||
            matched.international.additional != null)
    ) {
        return {
            eco: Number(matched.international.economy ?? 0),
            add: Number(matched.international.additional ?? 0),
            profile: "international",
            source: "matched",
        };
    }
    const dbPick = await lookupFromCache("international");
    if (dbPick) return dbPick;

    return { eco: 0, add: 0, profile: "international", source: "zero" };
}

// ======================== ADDITIONAL COSTS ========================

/**
 * Determine additional costs (embroidery, two_sided_print, etc.) by configCode.
 */
function resolveAdditionalCosts(configCode, matched) {
    const additionalCosts = {
        embroidery: 0,
        two_sided_print: 0,
        two_position_print: 0,
    };
    const code = (configCode || "").toUpperCase();

    if (["TSB"].includes(code)) {
        additionalCosts.two_sided_print = Number(
            matched?.additional_costs?.two_sided_print || 0
        );
    }
    if (["TS2S", "QZES"].includes(code)) {
        additionalCosts.two_position_print = Number(
            matched?.additional_costs?.two_position_print || 0
        );
    }
    if (["EBM", "EBMA"].includes(code)) {
        additionalCosts.embroidery = Number(
            matched?.additional_costs?.embroidery || 0
        );
    }

    const total =
        additionalCosts.embroidery +
        additionalCosts.two_sided_print +
        additionalCosts.two_position_print;

    return { additionalCosts, totalAdditionalCost: total };
}

// ======================== EBM/EBMA SPECIAL LOGIC ========================

/**
 * For EBM/EBMA configs, filter pfItems to only the 5th-order item.
 */
function filterEbmPfItems(configCode, pfItems) {
    if (!["EBM", "EBMA"].includes((configCode || "").toUpperCase())) {
        return pfItems;
    }

    const activeItems = pfItems.filter(
        (x) => (x?.status || "").toLowerCase() === "active"
    );
    const fifth = activeItems.find((x) => Number(x.order) === 5);
    if (fifth) return [fifth];

    const sorted = [...activeItems].sort(
        (a, b) => Number(a.order) - Number(b.order)
    );
    if (sorted.length >= 5) {
        logger.warn(
            "[EBM/EBMA] order===5 not found, using 5th item after sort."
        );
        return [sorted[4]];
    }
    // Return original if not enough items
    return pfItems;
}

// ======================== SKU HELPER ========================

function getSkuForCost(item) {
    const originalSku = (item?.sku || "").trim() || null;
    const mappedSku = (item?.mapped_sku || "").trim() || null;
    const usedSku = mappedSku || originalSku;
    return { originalSku, mappedSku, usedSku };
}

// ======================== MODULE EXPORTS ========================

module.exports = {
    // Utilities
    normalize,
    toArray,
    parseConfigCodeFromSKU,
    pickValueByKeys,
    getSkuForCost,

    // Label processing
    processCombinedLabels,

    // Label-value extractors
    extractLabelValueMapFromAmazonItem,
    extractLabelValueMapFromEtsyItem,

    // Config & mapping
    mapOptionValue,
    selectConfigByProductType,
    selectConfigByProductTypeEtsy,

    // Vendor matching
    findBestCostCenter,
    getVendorIdByVendorProductId,
    choosePreferredVendorIdStable,

    // Cache factory
    createCacheContext,

    // Shipping
    pickShippingFromDoc,
    resolveShippingRate,

    // Additional costs
    resolveAdditionalCosts,
    filterEbmPfItems,

    /**
     * The main business logic for computing base cost for an order.
     * Shared by both Amazon and Etsy modules.
     */
    async computeBaseCost(order, platform = "amazon") {
        if (!order || !Array.isArray(order.items) || order.items.length === 0) {
            throw new Error("Order has no items");
        }

        const shippingTypeForOrder = order.shipping_type || "Standard";
        const cache = this.createCacheContext({ platform });
        const { cachedSelectConfig, cachedMapOptionValue, cachedGetVendorId, cachedVendorCostCenters } = cache;

        const stagedItems = [];
        const preItems = [];
        const candidateSetsPerItem = [];

        // ============== PASS 1: Pre-scan and collect candidates ==============
        for (const item of order.items) {
            const { originalSku, mappedSku, usedSku } = this.getSkuForCost(item);
            const configCode = this.parseConfigCodeFromSKU(usedSku);

            if (!configCode) {
                stagedItems.push({
                    orderItemId: item.orderItemId,
                    sku: originalSku,
                    status: "failed",
                    reason: "Cannot parse config code from SKU",
                });
                continue;
            }

            const labelValueMap = platform === "etsy"
                ? this.extractLabelValueMapFromEtsyItem(item)
                : this.extractLabelValueMapFromAmazonItem(item);

            const { cfg, productTypeValue, matchedBy, reason: cfgReason } = await cachedSelectConfig(configCode, labelValueMap);

            if (!cfg) {
                stagedItems.push({
                    orderItemId: item.orderItemId,
                    sku: originalSku,
                    configCode,
                    status: "failed",
                    reason: cfgReason || "Config cost center not found",
                });
                continue;
            }

            const sizeRaw = this.pickValueByKeys(labelValueMap, cfg.customize_size_key || []);
            const colorRaw = this.pickValueByKeys(labelValueMap, cfg.customize_color_key || []);

            const sizeMap = await cachedMapOptionValue({ configCode, key: "size", rawValue: sizeRaw });
            const colorMap = await cachedMapOptionValue({ configCode, key: "color", rawValue: colorRaw });

            const sizeValue = sizeMap.value;
            const colorValue = colorMap.value;

            let pfItems = this.toArray(cfg?.product_for_seller?.items).filter(Boolean);
            if (!pfItems.length) {
                stagedItems.push({
                    orderItemId: item.orderItemId,
                    sku: originalSku,
                    configCode,
                    status: "failed",
                    reason: "product_for_seller has no items",
                });
                continue;
            }

            // Special EBM/EBMA logic
            pfItems = this.filterEbmPfItems(configCode, pfItems);

            preItems.push({
                item,
                sku: originalSku,
                mapped_sku: mappedSku,
                used_sku: usedSku,
                configCode,
                productTypeValue,
                matchedBy,
                sizeValue,
                colorValue,
                pfItems,
            });

            // collect candidate vendors
            const vendorSet = new Set();
            for (const pf of pfItems) {
                const vpId = pf?.vendor_product;
                if (!vpId) continue;
                const candidates = await cachedVendorCostCenters(vpId);
                const hit = this.findBestCostCenter(candidates, sizeValue, colorValue, { strict: true });
                if (hit) {
                    const vId = await cachedGetVendorId(vpId);
                    if (vId) vendorSet.add(vId);
                }
            }
            candidateSetsPerItem.push(vendorSet);
        }

        // ============== PASS 2: Choose preferred vendor and calculate final costs ==============
        const vendorRank = new Map(); // Can be expanded with dynamic ranks if needed
        const preferredVendorId = this.choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank);

        for (const pre of preItems) {
            let matched = null;
            let finalVendorProductId = null;

            // 1. Try preferred vendor first
            if (preferredVendorId) {
                const targetPf = pre.pfItems.find(async (pf) => {
                    const vId = await cachedGetVendorId(pf.vendor_product);
                    return String(vId) === String(preferredVendorId);
                });
                if (targetPf) {
                    const candidates = await cachedVendorCostCenters(targetPf.vendor_product);
                    matched = this.findBestCostCenter(candidates, pre.sizeValue, pre.colorValue, { strict: true });
                    if (matched) finalVendorProductId = targetPf.vendor_product;
                }
            }

            // 2. Fallback to first available candidate
            if (!matched) {
                for (const pf of pre.pfItems) {
                    const candidates = await cachedVendorCostCenters(pf.vendor_product);
                    matched = this.findBestCostCenter(candidates, pre.sizeValue, pre.colorValue, { strict: true });
                    if (matched) {
                        finalVendorProductId = pf.vendor_product;
                        break;
                    }
                }
            }

            if (!matched) {
                stagedItems.push({
                    orderItemId: pre.item.orderItemId,
                    sku: pre.sku,
                    configCode: pre.configCode,
                    status: "failed",
                    reason: "No vendor cost center matching size/color",
                });
                continue;
            }

            const { additionalCosts, totalAdditionalCost } = this.resolveAdditionalCosts(pre.configCode, matched);
            const shippingRate = await this.resolveShippingRate({
                matched,
                shippingType: shippingTypeForOrder,
                vendorProductId: finalVendorProductId,
                sizeValue: pre.sizeValue,
                colorValue: pre.colorValue,
                cache,
            });

            const qty = pre.item.quantity || 1;
            const itemBaseCost = Number(matched.base_cost || 0);
            const totalItemCost = (itemBaseCost + totalAdditionalCost) * qty + (shippingRate.eco + (qty - 1) * shippingRate.add);

            stagedItems.push({
                orderItemId: pre.item.orderItemId,
                sku: pre.sku,
                configCode: pre.configCode,
                vendor_product_id: finalVendorProductId,
                vendor_id: await cachedGetVendorId(finalVendorProductId),
                size: pre.sizeValue,
                color: pre.colorValue,
                base_cost: itemBaseCost,
                additional_costs: additionalCosts,
                shipping_cost: shippingRate.eco + (qty - 1) * shippingRate.add,
                total_cost: totalItemCost,
                status: "success",
            });
        }

        const totalOrderBaseCost = stagedItems.reduce((acc, cur) => acc + (cur.total_cost || 0), 0);

        return {
            items: stagedItems,
            totalBaseCost: totalOrderBaseCost,
            preferredVendorId,
            shippingTypeUsed: shippingTypeForOrder,
        };
    }
};

