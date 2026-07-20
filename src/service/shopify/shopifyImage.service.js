const CUSTOMALL_TYPE_BY_KEY = {
    _customall_preview: "preview",
    _customall_print_file: "print_file",
    _print_files: "print_file",
    _customized_url: "customized_url",
};

const CUSTOMALL_TEXT_KEYS = new Set([
    "_customallcustomid",
]);

function cleanString(value) {
    return value === null || value === undefined
        ? ""
        : String(value).trim();
}

function normalizeAttributes(customAttributes = []) {
    if (!Array.isArray(customAttributes)) return [];

    return customAttributes
        .map((attr) => ({
            key: cleanString(attr?.key || attr?.name),
            value: cleanString(attr?.value),
            source: cleanString(attr?.source || "shopify_line_item_custom_attributes"),
        }))
        .filter((attr) => attr.key || attr.value);
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(cleanString(value));
}

function getGenericType(key) {
    const text = cleanString(key).toLowerCase();

    if (text.includes("preview")) return "preview";
    if (text.includes("print")) return "print_file";
    if (text.includes("artwork")) return "artwork";
    if (text.includes("upload") || text.includes("photo")) {
        return "customer_upload";
    }
    if (text.includes("image")) return "image";
    if (text.includes("file")) return "file";

    return "";
}

function parseJsonValue(value) {
    try {
        return JSON.parse(value);
    } catch (_err) {
        return null;
    }
}

function collectUrlsFromValue(value) {
    const text = cleanString(value);
    if (!text) return [];
    if (isHttpUrl(text)) return [text];

    const parsed = parseJsonValue(text);
    if (!parsed) return [];

    const urls = [];
    const visit = (node) => {
        if (!node) return;
        if (typeof node === "string") {
            if (isHttpUrl(node)) urls.push(node);
            return;
        }
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        if (typeof node === "object") {
            Object.values(node).forEach(visit);
        }
    };

    visit(parsed);
    return urls;
}

function extractCustomFiles(customAttributes = []) {
    const files = [];
    const seen = new Set();

    for (const attr of normalizeAttributes(customAttributes)) {
        const normalizedKey = attr.key.toLowerCase();
        const knownType = CUSTOMALL_TYPE_BY_KEY[normalizedKey];
        const genericType = getGenericType(attr.key);
        const type = knownType || genericType;
        if (!type) continue;

        const urls = collectUrlsFromValue(attr.value);
        for (const url of urls) {
            const duplicateKey = `${type}:${url}`;
            if (seen.has(duplicateKey)) continue;
            seen.add(duplicateKey);

            files.push({
                key: attr.key,
                url,
                type,
                source: knownType ? "customall" : "generic",
            });
        }
    }

    return files;
}

function isLikelyCustomizationTextKey(key) {
    const text = cleanString(key).toLowerCase();
    if (CUSTOMALL_TEXT_KEYS.has(text)) return true;
    return [
        "name",
        "text",
        "message",
        "note",
        "quote",
        "title",
        "date",
        "year",
        "pet",
        "dog",
        "cat",
        "memorial",
        "custom",
        "personalization",
        "recipient",
    ].some((keyword) => text.includes(keyword));
}

function extractCustomTexts(customAttributes = []) {
    return normalizeAttributes(customAttributes).reduce((texts, attr) => {
        if (!attr.key || !attr.value || isHttpUrl(attr.value)) return texts;
        if (collectUrlsFromValue(attr.value).length > 0) return texts;
        if (!isLikelyCustomizationTextKey(attr.key)) return texts;

        texts.push({
            key: attr.key,
            value: attr.value,
            source: CUSTOMALL_TEXT_KEYS.has(attr.key.toLowerCase()) ? "customall" : "generic",
        });
        return texts;
    }, []);
}

function buildCustomization(customAttributes = []) {
    const attributes = normalizeAttributes(customAttributes);
    const files = extractCustomFiles(attributes);
    const texts = extractCustomTexts(attributes);
    const getText = (key) => texts.find((item) => item.key.toLowerCase() === key)?.value || "";

    return {
        attributes,
        files,
        texts,
        customall: {
            previewUrl: files.find((file) => file.key.toLowerCase() === "_customall_preview")?.url || "",
            printFileUrls: files
                .filter((file) => file.type === "print_file")
                .map((file) => file.url),
            customizedUrl: files.find((file) => file.key.toLowerCase() === "_customized_url")?.url || "",
            customId: getText("_customallcustomid"),
        },
    };
}

module.exports = {
    buildCustomization,
    extractCustomFiles,
    extractCustomTexts,
};
