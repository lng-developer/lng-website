const CUSTOMALL_TYPE_BY_KEY = {
    _customall_preview: "preview",
    _customall_print_file: "print_file",
    _print_files: "print_file",
    _customized_url: "customized_url",
};

function cleanString(value) {
    return value === null || value === undefined
        ? ""
        : String(value).trim();
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

function extractCustomFiles(customAttributes = []) {
    if (!Array.isArray(customAttributes)) return [];

    const files = [];
    const seen = new Set();

    for (const attr of customAttributes) {
        const key = cleanString(attr?.key || attr?.name);
        const url = cleanString(attr?.value);

        if (!key || !isHttpUrl(url)) continue;

        const normalizedKey = key.toLowerCase();
        const knownType = CUSTOMALL_TYPE_BY_KEY[normalizedKey];
        const genericType = getGenericType(key);
        const type = knownType || genericType;

        if (!type) continue;

        const duplicateKey = `${normalizedKey}:${url}`;

        if (seen.has(duplicateKey)) continue;
        seen.add(duplicateKey);

        files.push({
            key,
            url,
            type,
            source: knownType ? "customall" : "generic",
        });
    }

    return files;
}

module.exports = {
    extractCustomFiles,
};