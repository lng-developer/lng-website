/**
 * Test script: tính base cost cho Etsy order
 * Usage: node test-etsy-base-cost.js <orderId>
 * Ví dụ:  node test-etsy-base-cost.js 3974168919
 */
require("dotenv").config();
const mongoose = require("mongoose");

// ---- nạp tất cả model ----
const db = require("./src/models");
const EtsyOrder = db.EtsyOrder;
const ConfigCostCenter = db.configCostCenter;
const VendorCostCenter = db.vendorCostCenter;
const ConfigOptionMapping = db.configOptionMapping;

// ======================== HELPERS (copy từ controller) ========================

function parseConfigCodeFromSKU(sku = "") {
    const parts = String(sku).split("-").map((s) => s.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[1] : "";
}

function normalize(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toArray(val) {
    if (Array.isArray(val)) return val;
    if (val == null) return [];
    return [val];
}

function pickValueByKeys(labelValueMap, keys = []) {
    for (const k of toArray(keys)) {
        const v = labelValueMap.get(normalize(k));
        if (v != null && v !== "") return v;
    }
    return "";
}

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

async function selectConfigByProductType(configCode, labelValueMap, mapOptionValueFn = null) {
    console.log("🛠️ typeof mapOptionValueFn =", typeof mapOptionValueFn);
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
        let typeValRaw = pickValueByKeys(labelValueMap, c.customize_product_type_key || []);

        // Etsy fallback: nếu không tìm thấy key "Select Product Type", thử lấy "product type" (do extractLabelValueMapFromEtsyItem tạo ra)
        if (!typeValRaw && labelValueMap.has("product type")) {
            typeValRaw = labelValueMap.get("product type");
        }

        let typeValToMatch = normalize(typeValRaw);

        // Thử mapping biến thể kiểu product type nếu có mapOptionValueFn
        if (typeValRaw && mapOptionValueFn && !mappedProductTypeInfo) {
            mappedProductTypeInfo = await mapOptionValueFn({ configCode, key: "product type", rawValue: typeValRaw });
        }

        if (mappedProductTypeInfo && mappedProductTypeInfo.value && normalize(mappedProductTypeInfo.value) !== typeValToMatch) {
            typeValToMatch = normalize(mappedProductTypeInfo.value);
        }

        const sellerName = normalize(c?.product_for_seller?.name || "");
        if (typeValToMatch && sellerName && typeValToMatch === sellerName) {
            return { cfg: c, productTypeValue: typeValRaw, matchedBy: mappedProductTypeInfo?.matchType ? "product_type_mapped" : "product_type_exact" };
        }
    }

    if (cfgCandidates.length === 1) {
        const only = cfgCandidates[0];
        const typeValRaw = pickValueByKeys(labelValueMap, only.customize_product_type_key || []);
        return { cfg: only, productTypeValue: typeValRaw, matchedBy: "single_candidate_fallback" };
    }

    // Fallback: nếu từ khoá (vd "Sweatshirt") xuất hiện trong tên của 1 thằng duy nhất (vd "Premium Sweatshirt")
    const partialMatches = [];
    for (const c of cfgCandidates) {
        const typeValRaw = pickValueByKeys(labelValueMap, c.customize_product_type_key || []);
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

    return { cfg: null, reason: `Multiple configs (${cfgCandidates.length}) - partial matches (${partialMatches.length}); cannot determine by product type key/value` };
}

async function mapOptionValue({ configCode, key, rawValue }) {
    let val = String(rawValue ?? "");
    if (!val) return { value: val, ruleId: null, matchType: null };
    const rules = await ConfigOptionMapping.find({ config_code: configCode, key, active: { $ne: false } })
        .sort({ priority: 1, created_at: 1 }).lean();
    if (key === "product type") console.log(`🔍 mapOptionValue rules found for [${configCode}] [${key}] [${val}]:`, rules.length);
    const nl = (x) => normalize(x);
    const n = (x) => String(x || "").trim();
    for (const r of rules || []) {
        const mt = String(r.match_type || "equals").toLowerCase();
        const flags = r.regex_flags || "i";
        const cs = !!r.case_sensitive;
        const mval = String(r.match_value ?? ""); const mapped = String(r.mapped_value ?? "");

        if (key === "product type") console.log(`  - Checking rule [${mt}] ${mval} -> ${mapped}... val=${val} nl_val=${nl(val)} nl_mval=${nl(mval)}`);

        try {
            if (mt === "equals") { if (cs ? n(val) === n(mval) : nl(val) === nl(mval)) return { value: mapped, ruleId: String(r._id), matchType: mt }; }
            if (mt === "contains") { if (cs ? n(val).includes(n(mval)) : nl(val).includes(nl(mval))) return { value: mapped, ruleId: String(r._id), matchType: mt }; }
            if (mt === "regex") { if (new RegExp(mval, flags).test(val)) return { value: mapped, ruleId: String(r._id), matchType: mt }; }
            if (mt === "regex_replace") { const replaced = val.replace(new RegExp(mval, flags), mapped); if (replaced !== val) return { value: replaced, ruleId: String(r._id), matchType: mt }; }
        } catch (_e) { }
    }
    return { value: val, ruleId: null, matchType: null };
}

function findBestCostCenter(candidates, sizeValue, colorValue, { strict = true } = {}) {
    const norm = (s) => String(s || "").toLowerCase().trim();
    const hit = candidates.find((c) => norm(c.vendor_size) === norm(sizeValue) && norm(c.vendor_color) === norm(colorValue));
    if (hit) return hit;
    if (strict) return null;
    return null;
}

async function getVendorIdByVendorProductId(vpId) {
    const vp = await db.vendorProduct.findById(vpId).select("vendor_id").lean();
    return vp?.vendor_id ? String(vp.vendor_id) : null;
}

function choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) {
    if (!candidateSetsPerItem.length) return null;
    let inter = new Set(candidateSetsPerItem[0]);
    for (let i = 1; i < candidateSetsPerItem.length; i++) {
        inter = new Set([...inter].filter((v) => candidateSetsPerItem[i].has(v)));
        if (inter.size === 0) break;
    }
    if (!inter.size) return null;
    let best = null, bestRank = Infinity;
    for (const vId of inter) {
        const r = vendorRank.get(String(vId)) ?? 999;
        if (r < bestRank || (r === bestRank && String(vId) < String(best))) { best = vId; bestRank = r; }
    }
    return best;
}

// ======================== MAIN ========================

async function computeForOrder(orderId) {
    const order = await EtsyOrder.findOne({ orderId }).lean();
    if (!order) throw new Error(`Etsy order "${orderId}" not found`);
    if (!order.items?.length) throw new Error("Order has no items");

    const shippingTypeForOrder = "Standard";

    // caches
    const _cfgCache = new Map(), _optCache = new Map(), _vpIdCache = new Map(), _vccCache = new Map();
    const cachedMapOption = async (o) => { const k = `${o.configCode}::${o.key}::${o.rawValue}`; if (_optCache.has(k)) return _optCache.get(k); const r = await mapOptionValue(o); _optCache.set(k, r); return r; };
    const cachedSelectConfig = async (cc, lvm) => { if (_cfgCache.has(cc)) return _cfgCache.get(cc); const r = await selectConfigByProductType(cc, lvm, cachedMapOption); _cfgCache.set(cc, r); return r; };
    const cachedVendorId = async (vpId) => { const k = String(vpId); if (_vpIdCache.has(k)) return _vpIdCache.get(k); const r = await getVendorIdByVendorProductId(vpId); _vpIdCache.set(k, r); return r; };
    const cachedVCC = async (vpId) => { const k = String(vpId); if (_vccCache.has(k)) return _vccCache.get(k); const docs = await VendorCostCenter.find({ vendor_product: vpId, status: { $in: ["Active", "active", null] } }).select("vendor_size vendor_color standard_size standard_color base_cost sku international priority additional_costs").lean(); _vccCache.set(k, docs); return docs; };

    // PASS 1
    const stagedItems = [], preItems = [], candidateSetsPerItem = [];

    for (const item of order.items) {
        const itemId = item.transactionId;
        const sku = (item?.sku || "").trim() || null;
        const configCode = parseConfigCodeFromSKU(sku);
        if (!configCode) { stagedItems.push({ transactionId: itemId, sku, status: "failed", reason: "Cannot parse config code" }); continue; }

        const labelValueMap = extractLabelValueMapFromEtsyItem(item);
        console.log(`\n📋 Item ${itemId} | SKU: ${sku} | configCode: ${configCode}`);
        console.log("   variations →", Object.fromEntries(labelValueMap));

        const { cfg, productTypeValue, matchedBy, reason: cfgReason } = await cachedSelectConfig(configCode, labelValueMap);
        if (!cfg) { stagedItems.push({ transactionId: itemId, sku, configCode, status: "failed", reason: cfgReason }); continue; }

        const sizeRaw = pickValueByKeys(labelValueMap, cfg.customize_size_key || []);
        const colorRaw = pickValueByKeys(labelValueMap, cfg.customize_color_key || []);
        const sizeMap = await cachedMapOption({ configCode, key: "size", rawValue: sizeRaw });
        const colorMap = await cachedMapOption({ configCode, key: "color", rawValue: colorRaw });
        console.log(`   size: "${sizeRaw}" → "${sizeMap.value}" | color: "${colorRaw}" → "${colorMap.value}"`);

        let pfItems = toArray(cfg?.product_for_seller?.items).filter(Boolean);
        if (!pfItems.length) { stagedItems.push({ transactionId: itemId, sku, configCode, status: "failed", reason: "No pfItems" }); continue; }

        if (["EBM", "EBMA"].includes(configCode.toUpperCase())) {
            const activeItems = pfItems.filter((x) => (x?.status || "").toLowerCase() === "active");
            const fifth = activeItems.find((x) => Number(x.order) === 5);
            if (fifth) pfItems = [fifth];
            else { const sorted = [...activeItems].sort((a, b) => Number(a.order) - Number(b.order)); pfItems = sorted.length >= 5 ? [sorted[4]] : pfItems; }
        }

        preItems.push({ item, itemId, sku, used_sku: sku, configCode, productTypeValue, matchedBy, sizeValue: sizeMap.value, colorValue: colorMap.value, pfItems });

        const vendorSet = new Set();
        for (const pf of pfItems) {
            const vpId = pf?.vendor_product; if (!vpId) continue;
            const candidates = await cachedVCC(vpId);
            const hit = findBestCostCenter(candidates, sizeMap.value, colorMap.value, { strict: true });
            if (!hit) continue;
            const vId = String(pf?.vendor_id || pf?.vendor?._id || (await cachedVendorId(vpId)) || "");
            if (vId) vendorSet.add(vId);
        }
        candidateSetsPerItem.push(vendorSet);
    }

    let preferredVendorId = null;
    if (preItems.length >= 2) {
        const vendorRank = new Map();
        for (const pre of preItems) { for (const it of toArray(pre.pfItems)) { const vpId = it?.vendor_product; if (!vpId) continue; const vId = String(it?.vendor_id || it?.vendor?._id || (await cachedVendorId(vpId)) || ""); if (!vId) continue; vendorRank.set(vId, Math.min(vendorRank.get(vId) ?? 999, it.order ?? 999)); } }
        preferredVendorId = choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) || null;
    }

    // PASS 2
    const groups = new Map();
    for (const pre of preItems) {
        const { item, itemId, sku, configCode, productTypeValue, matchedBy, sizeValue, colorValue } = pre;
        const { pfItems } = pre;

        const vendorSelection = await (async () => {
            const byOrder = (a, b) => (a.order || 999) - (b.order || 999);
            const actives = pfItems.filter((it) => String(it.status || "").toLowerCase() === "active").sort(byOrder);
            let itemsToCheck = actives.length ? actives : [...pfItems].sort(byOrder);
            const resolved = [];
            for (const it of itemsToCheck) { const vpId = it?.vendor_product; if (!vpId) continue; const vId = String(it?.vendor_id || it?.vendor?._id || (await cachedVendorId(vpId)) || ""); resolved.push({ ...it, __vendorId: vId, __vendorProductId: vpId }); }
            const filtered = preferredVendorId ? resolved.filter((x) => x.__vendorId && String(x.__vendorId) === String(preferredVendorId)) : resolved;
            if (preferredVendorId && filtered.length === 0) return { success: false, reason: `No pfItems under vendor ${preferredVendorId}` };
            const checkList = filtered.length ? filtered : resolved;
            for (const cItem of checkList) {
                const candidates = await cachedVCC(cItem.__vendorProductId); if (!candidates?.length) continue;
                let hit = findBestCostCenter(candidates, sizeValue, colorValue, { strict: true });
                if (!hit) hit = findBestCostCenter(candidates, sizeValue, colorValue, { strict: false });
                if (hit && Number(hit?.base_cost || 0) > 0) return { success: true, vendorProductId: cItem.__vendorProductId, matched: hit, selectedOrder: cItem.order || 999, itemDisplayName: cItem.display_name || "Unknown", vendorId: cItem.__vendorId };
            }
            return { success: false, reason: "No matching vendor product" };
        })();

        if (!vendorSelection.success) { stagedItems.push({ transactionId: itemId, sku, configCode, sizeValue, colorValue, status: "failed", reason: vendorSelection.reason }); continue; }

        const { vendorProductId, matched, selectedOrder, itemDisplayName, vendorId } = vendorSelection;
        const baseEach = Number(matched?.base_cost || 0);
        const qty = Math.max(1, Number(item.quantity || 1));

        // shipping
        const rate = await (async () => {
            const pickFromDoc = (doc, pp) => { if (!doc) return null; const hp = doc.priority && (doc.priority.economy != null || doc.priority.additional != null); const hi = doc.international && (doc.international.economy != null || doc.international.additional != null); if (pp === "priority" && hp) return { eco: Number(doc.priority.economy ?? 0), add: Number(doc.priority.additional ?? 0), profile: "priority" }; if (hi) return { eco: Number(doc.international.economy ?? 0), add: Number(doc.international.additional ?? 0), profile: "international" }; return null; };
            if (matched?.international && (matched.international.economy != null || matched.international.additional != null))
                return { eco: Number(matched.international.economy ?? 0), add: Number(matched.international.additional ?? 0), profile: "international" };
            const allDocs = await cachedVCC(vendorProductId);
            for (const doc of allDocs) { const p = pickFromDoc(doc, "international"); if (p) return p; }
            return { eco: 0, add: 0, profile: "international" };
        })();

        const additionalCosts = { embroidery: 0, two_sided_print: 0, two_position_print: 0 };
        if (["TSB"].includes(configCode.toUpperCase())) additionalCosts.two_sided_print = Number(matched?.additional_costs?.two_sided_print || 0);
        if (["TS2S"].includes(configCode.toUpperCase())) additionalCosts.two_position_print = Number(matched?.additional_costs?.two_position_print || 0);
        if (["EBM", "EBMA"].includes(configCode.toUpperCase())) additionalCosts.embroidery = Number(matched?.additional_costs?.embroidery || 0);
        const totalAdditionalCost = additionalCosts.embroidery + additionalCosts.two_sided_print + additionalCosts.two_position_print;

        const rec = { transactionId: itemId, sku, used_sku: sku, configCode, productTypeValue: productTypeValue || null, selectedConfigBy: matchedBy || "unknown", sizeValue, colorValue, vendorProductId, vendorId, selectedOrder, itemDisplayName, baseEach, qty, eco: rate.eco, add: rate.add, shipProfile: rate.profile, matchedSku: matched?.sku || null, additionalCosts, totalAdditionalCost, status: "ok" };
        stagedItems.push(rec);
        const key = `${vendorId}::profile=${rate.profile}::eco=${rate.eco}::add=${rate.add}`;
        const g = groups.get(key) || { vendorId, shipProfile: rate.profile, items: [], economyMax: 0 };
        g.items.push({ ...rec }); g.economyMax = Math.max(g.economyMax, rate.eco); groups.set(key, g);
    }

    // Tổng hợp
    const perItemResults = [];
    const groupBreakdowns = [];
    for (const rec of stagedItems) {
        if (rec.status !== "ok") { perItemResults.push(rec); continue; }
        perItemResults.push({
            transactionId: rec.transactionId, sku: rec.sku, configCode: rec.configCode, sizeValue: rec.sizeValue, colorValue: rec.colorValue,
            vendorProductId: rec.vendorProductId, vendorId: rec.vendorId, matchedSku: rec.matchedSku, selectedOrder: rec.selectedOrder, itemDisplayName: rec.itemDisplayName,
            base_cost_each: rec.baseEach, quantity: rec.qty,
            additional_costs_breakdown: rec.additionalCosts, total_additional_cost_per_item: rec.totalAdditionalCost * rec.qty,
            shipping_international_economy: 0, shipping_international_additional_units: 0, shipping_international_additional_rate: 0,
            base_cost_total_for_item_including_shipping: rec.baseEach * rec.qty + rec.totalAdditionalCost * rec.qty,
            status: "ok",
        });
    }

    // Phân bổ shipping (simplified — 1 eco + remaining add)
    for (const [, g] of groups.entries()) {
        const totalQtyProfile = g.items.reduce((s, it) => s + it.qty, 0);
        if (totalQtyProfile <= 0) continue;
        const ecoOnce = g.economyMax;
        let remainEco = 1, remainAdd = Math.max(0, totalQtyProfile - 1);
        const sorted = [...g.items].sort((a, b) => b.eco - a.eco);
        for (const it of sorted) {
            const out = perItemResults.find((r) => r.transactionId === it.transactionId && r.status === "ok"); if (!out) continue;
            let ecoHere = 0;
            if (remainEco > 0 && it.qty > 0) { ecoHere = ecoOnce; remainEco = 0; }
            let addUnits = it.qty - (ecoHere > 0 ? 1 : 0);
            addUnits = Math.max(0, Math.min(addUnits, remainAdd)); remainAdd -= addUnits;
            out.shipping_international_economy += ecoHere;
            out.shipping_international_additional_units += addUnits;
            out.shipping_international_additional_rate = it.add;
            out.base_cost_total_for_item_including_shipping = Number((out.base_cost_total_for_item_including_shipping + ecoHere + addUnits * it.add).toFixed(2));
            out.formula = `(base ${it.baseEach} × qty ${it.qty}) + add_cost ${it.totalAdditionalCost} × qty ${it.qty} + [${g.shipProfile}] eco ${ecoHere} + add ${it.add} × ${addUnits}`;
        }
        groupBreakdowns.push({ vendor_id: g.vendorId, total_qty: totalQtyProfile, shipping_profile: g.shipProfile, shipping_economy_once: ecoOnce });
    }

    let total = 0;
    for (const r of perItemResults) if (r.status === "ok") total += r.base_cost_total_for_item_including_shipping;

    return {
        platform: "etsy",
        orderId,
        base_cost: Number(total.toFixed(2)),
        preferred_vendor_id: preferredVendorId || null,
        shipping_group_breakdowns: groupBreakdowns,
        detail: perItemResults,
    };
}

// ======================== RUN ========================

(async () => {
    const orderId = process.argv[2];
    if (!orderId) {
        console.error("❌ Usage: node test-etsy-base-cost.js <orderId>");
        process.exit(1);
    }

    try {
        const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/lng_db";
        console.log("🔌 Connecting to MongoDB...");
        await mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log("✅ Connected!\n");

        console.log(`🧮 Computing base cost for Etsy order: ${orderId}\n`);
        const result = await computeForOrder(orderId);

        console.log("\n" + "=".repeat(60));
        console.log("📊 RESULT:");
        console.log("=".repeat(60));
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await mongoose.disconnect();
        console.log("\n🔌 Disconnected.");
    }
})();
