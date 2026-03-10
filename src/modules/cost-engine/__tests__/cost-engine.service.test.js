// src/modules/cost-engine/__tests__/cost-engine.service.test.js
//
// Unit tests for the pure/utility functions in cost-engine.service.
// These tests do NOT require a database connection.

const {
    normalize,
    toArray,
    parseConfigCodeFromSKU,
    pickValueByKeys,
    getSkuForCost,
    extractLabelValueMapFromAmazonItem,
    extractLabelValueMapFromEtsyItem,
    findBestCostCenter,
    choosePreferredVendorIdStable,
    resolveAdditionalCosts,
    filterEbmPfItems,
} = require("../cost-engine.service");

// ======================== normalize ========================
describe("normalize", () => {
    it("lowercases and trims", () => {
        expect(normalize("  Hello World  ")).toBe("hello world");
    });

    it("collapses multiple spaces", () => {
        expect(normalize("a   b   c")).toBe("a b c");
    });

    it("handles null/undefined", () => {
        expect(normalize(null)).toBe("");
        expect(normalize(undefined)).toBe("");
    });
});

// ======================== toArray ========================
describe("toArray", () => {
    it("returns array as-is", () => {
        expect(toArray([1, 2])).toEqual([1, 2]);
    });

    it("wraps single value", () => {
        expect(toArray("a")).toEqual(["a"]);
    });

    it("returns empty for null/undefined", () => {
        expect(toArray(null)).toEqual([]);
        expect(toArray(undefined)).toEqual([]);
    });
});

// ======================== parseConfigCodeFromSKU ========================
describe("parseConfigCodeFromSKU", () => {
    it("extracts second segment", () => {
        expect(parseConfigCodeFromSKU("LNG-TSB-001")).toBe("TSB");
    });

    it("handles dash-separated SKU", () => {
        expect(parseConfigCodeFromSKU("SELLER-EBM-SIZE-COLOR")).toBe("EBM");
    });

    it("returns empty for single segment", () => {
        expect(parseConfigCodeFromSKU("NOSKUFORMAT")).toBe("");
    });

    it("handles empty/null", () => {
        expect(parseConfigCodeFromSKU("")).toBe("");
        expect(parseConfigCodeFromSKU()).toBe("");
    });
});

// ======================== pickValueByKeys ========================
describe("pickValueByKeys", () => {
    const map = new Map([
        ["size", "XL"],
        ["color", "Red"],
        ["product type", "Hoodie"],
    ]);

    it("finds value by exact key", () => {
        expect(pickValueByKeys(map, ["size"])).toBe("XL");
    });

    it("finds first matching key", () => {
        expect(pickValueByKeys(map, ["missing", "color"])).toBe("Red");
    });

    it("returns empty for no match", () => {
        expect(pickValueByKeys(map, ["nope"])).toBe("");
    });

    it("handles empty keys", () => {
        expect(pickValueByKeys(map, [])).toBe("");
    });
});

// ======================== getSkuForCost ========================
describe("getSkuForCost", () => {
    it("prefers mapped_sku over sku", () => {
        const result = getSkuForCost({ sku: "ORIG-TSB-001", mapped_sku: "MAPPED-TSB-002" });
        expect(result.usedSku).toBe("MAPPED-TSB-002");
        expect(result.originalSku).toBe("ORIG-TSB-001");
        expect(result.mappedSku).toBe("MAPPED-TSB-002");
    });

    it("falls back to original sku when no mapped", () => {
        const result = getSkuForCost({ sku: "ORIG-TSB-001" });
        expect(result.usedSku).toBe("ORIG-TSB-001");
        expect(result.mappedSku).toBeNull();
    });

    it("handles empty item", () => {
        const result = getSkuForCost({});
        expect(result.usedSku).toBeNull();
    });
});

// ======================== extractLabelValueMapFromAmazonItem ========================
describe("extractLabelValueMapFromAmazonItem", () => {
    it("extracts from version3Data surfaces", () => {
        const item = {
            version3Data: {
                customizationInfo: {
                    surfaces: [{
                        areas: [
                            { label: "Size", optionValue: "XL" },
                            { label: "Color", text: "Navy" },
                        ],
                    }],
                },
            },
        };
        const map = extractLabelValueMapFromAmazonItem(item);
        expect(map.get("size")).toBe("XL");
        expect(map.get("color")).toBe("Navy");
    });

    it("fallback to customizationData when no v3", () => {
        const item = {
            customizationData: {
                children: [{
                    children: [{
                        children: [
                            { label: "Size", optionSelection: { label: "Medium" } },
                            { label: "Font", inputValue: "Script" },
                        ],
                    }],
                }],
            },
        };
        const map = extractLabelValueMapFromAmazonItem(item);
        expect(map.get("size")).toBe("Medium");
        expect(map.get("font")).toBe("Script");
    });
});

// ======================== extractLabelValueMapFromEtsyItem ========================
describe("extractLabelValueMapFromEtsyItem", () => {
    it("extracts from variations object", () => {
        const item = {
            variations: {
                Size: "Large",
                Color: "Black",
            },
        };
        const map = extractLabelValueMapFromEtsyItem(item);
        expect(map.get("size")).toBe("Large");
        expect(map.get("color")).toBe("Black");
    });

    it("splits 'Style - Size' combined field", () => {
        const item = {
            variations: {
                "Style - Size": "Hoodie - XL",
            },
        };
        const map = extractLabelValueMapFromEtsyItem(item);
        expect(map.get("style")).toBe("Hoodie");
        expect(map.get("size")).toBe("XL");
        expect(map.get("product type")).toBe("Hoodie");
    });
});

// ======================== findBestCostCenter ========================
describe("findBestCostCenter", () => {
    const candidates = [
        { vendor_size: "S", vendor_color: "Red", base_cost: 5 },
        { vendor_size: "M", vendor_color: "Blue", base_cost: 6 },
        { vendor_size: "L", vendor_color: "Green", base_cost: 7 },
    ];

    it("finds exact match (case-insensitive)", () => {
        const hit = findBestCostCenter(candidates, "m", "blue");
        expect(hit).toBeTruthy();
        expect(hit.base_cost).toBe(6);
    });

    it("returns null when no match in strict mode", () => {
        const hit = findBestCostCenter(candidates, "XL", "Purple", { strict: true });
        expect(hit).toBeNull();
    });
});

// ======================== choosePreferredVendorIdStable ========================
describe("choosePreferredVendorIdStable", () => {
    it("returns intersection vendor with best rank", () => {
        const sets = [
            new Set(["v1", "v2", "v3"]),
            new Set(["v2", "v3", "v4"]),
            new Set(["v2", "v5"]),
        ];
        const rank = new Map([["v2", 1], ["v3", 2]]);
        expect(choosePreferredVendorIdStable(sets, rank)).toBe("v2");
    });

    it("returns null when no intersection", () => {
        const sets = [
            new Set(["v1"]),
            new Set(["v2"]),
        ];
        const rank = new Map();
        expect(choosePreferredVendorIdStable(sets, rank)).toBeNull();
    });

    it("returns null for empty input", () => {
        expect(choosePreferredVendorIdStable([], new Map())).toBeNull();
    });
});

// ======================== resolveAdditionalCosts ========================
describe("resolveAdditionalCosts", () => {
    const matched = {
        additional_costs: {
            embroidery: 2.5,
            two_sided_print: 1.5,
            two_position_print: 3.0,
        },
    };

    it("TSB → two_sided_print only", () => {
        const { additionalCosts, totalAdditionalCost } = resolveAdditionalCosts("TSB", matched);
        expect(additionalCosts.two_sided_print).toBe(1.5);
        expect(additionalCosts.embroidery).toBe(0);
        expect(totalAdditionalCost).toBe(1.5);
    });

    it("EBM → embroidery only", () => {
        const { additionalCosts, totalAdditionalCost } = resolveAdditionalCosts("EBM", matched);
        expect(additionalCosts.embroidery).toBe(2.5);
        expect(totalAdditionalCost).toBe(2.5);
    });

    it("TS2S → two_position_print", () => {
        const { additionalCosts } = resolveAdditionalCosts("TS2S", matched);
        expect(additionalCosts.two_position_print).toBe(3.0);
    });

    it("unknown config → all zero", () => {
        const { totalAdditionalCost } = resolveAdditionalCosts("ABC", matched);
        expect(totalAdditionalCost).toBe(0);
    });
});

// ======================== filterEbmPfItems ========================
describe("filterEbmPfItems", () => {
    it("returns original items for non-EBM config", () => {
        const items = [{ order: 1 }, { order: 2 }];
        expect(filterEbmPfItems("TSB", items)).toEqual(items);
    });

    it("picks order=5 item for EBM config", () => {
        const items = [
            { order: 1, status: "active" },
            { order: 3, status: "active" },
            { order: 5, status: "active" },
        ];
        const result = filterEbmPfItems("EBM", items);
        expect(result).toHaveLength(1);
        expect(result[0].order).toBe(5);
    });
});

