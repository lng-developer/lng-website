/**
* ENHANCED MAPPING TEST SCRIPT
* Test combined label processing functionality
*/

const dotenv = require('dotenv');
dotenv.config();
const mongoose = require('mongoose');
const {
    extractLabelValueMapFromAmazonItem,
    processCombinedLabels
} = require('./src/modules/cost-engine/cost-engine.service');

// Test data with combined labels
const testData = {
    platform: 'Amazon',
    sku: 'J2503-TS2S-100126-6626',
    customization: {
        version3Data: {
            customizationInfo: {
                surfaces: [{
                    areas: [
                        { label: "Color/Select Product Type", optionValue: "Sand /Premium Sweatshirt" },
                        { label: "Select Size", optionValue: "L" },
                    ],
                }],
            },
        }
    }
};

async function runTest() {
    console.log('--- STARTING ENHANCED MAPPING TEST ---');

    try {
        await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.DB_NAME });
        console.log('✅ Connected to DB');
    } catch (err) {
        console.error('❌ DB Connection failed:', err.message);
        process.exit(1);
    }

    try {
        console.log('\n[Input] Testing combined labels:');
        console.log('- "Color/Select Product Type": "Sand /Premium Sweatshirt"');
        console.log('- "Select Size": "L"');

        // Test 1: Raw extraction
        console.log('\n[Step 1] Raw label-value extraction:');
        const rawMap = extractLabelValueMapFromAmazonItem(testData.customization);
        
        console.log('Raw mappings:');
        for (let [k, v] of rawMap) {
            console.log(`   - ${k}: "${v}"`);
        }

        // Test 2: Combined label processing
        console.log('\n[Step 2] After combined label processing:');
        const processedMap = processCombinedLabels(rawMap);
        
        console.log('Processed mappings:');
        for (let [k, v] of processedMap) {
            console.log(`   - ${k}: "${v}"`);
        }

        // Test 3: Check if we have the expected keys
        console.log('\n[Step 3] Key availability check:');
        const expectedKeys = ['select product type', 'color', 'select size'];
        expectedKeys.forEach(key => {
            const value = processedMap.get(key);
            console.log(`   - ${key}: ${value ? `"${value}" ✅` : '❌ NOT FOUND'}`);
        });

        // Test 4: Full end-to-end test
        console.log('\n[Step 4] Full vendor matching test:');
        const costEngine = require('./src/modules/cost-engine/cost-engine.service');
        
        const mockOrder = {
            shipping_type: 'Standard',
            items: [
                {
                    orderItemId: 'MOCK-ITEM-001',
                    sku: testData.sku,
                    quantity: 1,
                    version3Data: testData.customization.version3Data
                }
            ]
        };

        const result = await costEngine.computeBaseCost(mockOrder, testData.platform.toLowerCase());
        
        if (result.items[0].status === 'success') {
            console.log('   ✅ VENDOR MATCH SUCCESS!');
            console.log(`   - Config Code: ${result.items[0].configCode}`);
            console.log(`   - Mapped Size: ${result.items[0].size}`);
            console.log(`   - Mapped Color: ${result.items[0].color}`);
            console.log(`   - Vendor ID: ${result.items[0].vendor_id || 'Not Found'}`);
            console.log(`   - Total Cost: $${result.items[0].total_cost}`);
        } else {
            console.log('   ❌ VENDOR MATCH FAILED');
            console.log(`   - Reason: ${result.items[0].reason}`);
        }

    } catch (error) {
        console.error('❌ Test error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n--- TEST COMPLETE ---');
    }
}

runTest();
