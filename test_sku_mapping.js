/**
* SANDBOX TEST SCRIPT - STEP 2: MAPPING LOGIC
* Hướng dẫn: 
* 1. Bạn dán dữ liệu SKU và Customization vào phần 'testData' bên dưới.
* 2. Chạy lệnh: node test_sku_mapping.js
* Script này chỉ ĐỌC dữ liệu cấu hình từ DB để test, tuyệt đối KHÔNG ghi/sửa đơn hàng.
*/

const dotenv = require('dotenv');
dotenv.config();
const mongoose = require('mongoose');
const {
    parseConfigCodeFromSKU,
    extractLabelValueMapFromAmazonItem,
    extractLabelValueMapFromEtsyItem,
    mapOptionValue
} = require('./src/modules/cost-engine/cost-engine.service');

// --- Cấu hình dữ liệu TEST của bạn ở đây ---
const testData = {
    platform: 'Amazon',
    sku: 'J2503-TS2S-100126-6626',
    // Giả lập dữ liệu tùy chỉnh từ Amazon trả về (theo label/value người dùng cung cấp)
    customization: {
        version3Data: {
            customizationInfo: {
                surfaces: [{
                    areas: [
                        { label: "Custom Main text", text: "Madrina" },
                        { label: "Enter Est", text: "x" },
                        { label: "Enter Name on Sleeve", text: "Scar" },
                        { label: "Select Product Type", optionValue: "Quarter Zip Sweatshirt" },
                        { label: "Color", optionValue: "Forest green" },
                        { label: "Select Size", optionValue: "XL" },
                        { label: "Priority Production", optionValue: "No, Thanks." },
                    ],
                }],
            },
        }
    }
};

async function runTest() {
    console.log('--- STARTING MAPPING TEST ---');

    // 1. Kết nối DB
    try {
        await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.DB_NAME });
        console.log('✅ Connected to DB');
    } catch (err) {
        console.error('❌ DB Connection failed:', err.message);
        process.exit(1);
    }

    try {
        // BƯỚC A: Tách Config Code từ SKU
        const configCode = parseConfigCodeFromSKU(testData.sku);
        console.log(`\n[Step A] Parsing SKU: "${testData.sku}"`);
        console.log(`=> Result Config Code: "${configCode}"`);

        // BƯỚC B: Trích xuất Label-Value Map
        const labelValueMap = extractLabelValueMapFromAmazonItem(testData.customization);

        console.log('\n[Step B] Extracted Label-Value Map:');
        for (let [k, v] of labelValueMap) {
            console.log(`   - ${k}: "${v}"`);
        }

        // BƯỚC C: Ánh xạ dữ liệu (Dựa trên rules trong DB)
        // Chúng ta sẽ test các key quan trọng: size, color, và product type
        console.log('\n[Step C] Application of Mapping Rules (from DB):');

        // Cần xác định key nào trong labelValueMap tương ứng với size/color/product type
        // Dựa trên dữ liệu: "Select Size", "Color", "Select Product Type"
        const mappingsToTest = [
            { key: 'size', labels: ['select size', 'size'] },
            { key: 'color', labels: ['color'] },
            { key: 'product type', labels: ['select product type', 'product type'] }
        ];

        for (const meta of mappingsToTest) {
            let rawValue = '';
            let usedLabel = '';
            for (const label of meta.labels) {
                if (labelValueMap.has(label)) {
                    rawValue = labelValueMap.get(label);
                    usedLabel = label;
                    break;
                }
            }

            if (rawValue) {
                const mapped = await mapOptionValue({ configCode, key: meta.key, rawValue });
                console.log(`   - ${meta.key.toUpperCase()} (from label "${usedLabel}"):`);
                console.log(`     "${rawValue}" -> Mapped to: "${mapped.value}" (Rule: ${mapped.matchType || 'None'})`);
            } else {
                console.log(`   - ${meta.key.toUpperCase()}: Label not found in customization.`);
            }
        }

    } catch (error) {
        console.error('❌ Test error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n--- TEST COMPLETE ---');
    }
}

runTest();
