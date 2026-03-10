/**
* VENDOR & COST MATCHING TEST SCRIPT
* Hướng dẫn:
* 1. Dán dữ liệu order từ sàn vào testData.
* 2. Chạy: node test_vendor_matching.js
*/

const dotenv = require('dotenv');
dotenv.config();
const mongoose = require('mongoose');
const costEngine = require('./src/modules/cost-engine/cost-engine.service');

const testData = {
    platform: 'Amazon',
    sku: 'J2503-TS2S-100126-6626',
    customization: {
        version3Data: {
            customizationInfo: {
                surfaces: [{
                    areas: [
                        { label: "Select Product Type/Color", optionValue: "Premium Sweatshirt/Sand" },
                        { label: "Select Size", optionValue: "L" },
                    ],
                }],
            },
        }
    }
};

async function runTest() {
    console.log('--- STARTING VENDOR & COST MATCHING TEST ---');

    try {
        await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.DB_NAME });
        console.log('✅ Connected to DB');
    } catch (err) {
        console.error('❌ DB Connection failed:', err.message);
        process.exit(1);
    }

    try {
        // Giả lập một object "order" để truyền vào computeBaseCost
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

        console.log(`\n[Input] Testing SKU: "${testData.sku}"`);
        console.log(`[Input] Platform: ${testData.platform}`);

        // GỌI HÀM CORE: computeBaseCost
        const result = await costEngine.computeBaseCost(mockOrder, testData.platform.toLowerCase());

        console.log('\n[Result] Application Logic Breakdown:');
        result.items.forEach(item => {
            if (item.status === 'success') {
                console.log(`   ✅ MATCH SUCCESS:`);
                console.log(`   - Config Code: ${item.configCode}`);
                console.log(`   - Mapped Size: ${item.size}`);
                console.log(`   - Mapped Color: ${item.color}`);
                console.log(`   - Vendor ID: ${item.vendor_id || 'Not Found'}`);
                console.log(`   - Vendor Product ID: ${item.vendor_product_id}`);
                console.log(`   - Base Cost: $${item.base_cost}`);
                console.log(`   - Shipping: $${item.shipping_cost}`);
                console.log(`   - Additional Costs: $${JSON.stringify(item.additional_costs)}`);
                console.log(`   - TOTAL ITEM COST: $${item.total_cost}`);
            } else {
                console.log(`   ❌ MATCH FAILED:`);
                console.log(`   - Reason: ${item.reason}`);
            }
        });

        console.log(`\n[Final] Total Order Base Cost: $${result.totalBaseCost}`);
        console.log(`[Final] Preferred Vendor for Order: ${result.preferredVendorId || 'N/A'}`);

        if (!result.preferredVendorId) {
            console.log('\n💡 Tip: Nếu không bắt được Vendor, hãy kiểm tra:');
            console.log('1. ConfigCostCenter của mã "TS2S" có sản phẩm nào tương ứng không?');
            console.log('2. VendorProduct đó có bảng giá (VendorCostCenter) cho Size/Color này không?');
        }

    } catch (error) {
        console.error('❌ Test error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n--- TEST COMPLETE ---');
    }
}

runTest();
