const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const { ShippingBatch } = require('./src/models');

async function checkShopBatches() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const shopId = '6977178d9e8e7a4069e38170';
    console.log(`🔍 Checking batches for shop: ${shopId}`);

    // 1. Tổng số batches của shop này
    const totalBatches = await ShippingBatch.countDocuments({
      machineId: shopId
    });
    console.log(`📊 Total batches for this shop: ${totalBatches}`);

    // 2. Batches theo status
    const statusBreakdown = await ShippingBatch.aggregate([
      { $match: { machineId: shopId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    console.log('\n📋 Batches by status:');
    statusBreakdown.forEach(item => {
      console.log(`  ${item._id}: ${item.count} batches`);
    });

    // 3. Batches có completed data
    const batchesWithCompleted = await ShippingBatch.countDocuments({
      machineId: shopId,
      status: 'CONFIRM_FILE_READY',
      completed: { $exists: true, $ne: [] }
    });
    console.log(`\n📦 Batches with completed data: ${batchesWithCompleted}`);

    // 4. Batches chưa gửi task
    const batchesNotSent = await ShippingBatch.countDocuments({
      machineId: shopId,
      status: 'CONFIRM_FILE_READY',
      completed: { $exists: true, $ne: [] },
      uploadTaskSent: { $ne: true }
    });
    console.log(`📤 Batches not sent yet: ${batchesNotSent}`);

    // 5. Batches đã gửi task
    const batchesSent = await ShippingBatch.countDocuments({
      machineId: shopId,
      uploadTaskSent: true
    });
    console.log(`✅ Batches already sent: ${batchesSent}`);

    // 6. Sample batches gần đây
    console.log('\n📋 Recent batches (last 5):');
    const recentBatches = await ShippingBatch.find({
      machineId: shopId
    })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

    recentBatches.forEach((batch, index) => {
      console.log(`\n${index + 1}. Batch ${batch._id}:`);
      console.log(`   Label: ${batch.label || 'N/A'}`);
      console.log(`   Status: ${batch.status}`);
      console.log(`   Created: ${batch.createdAt}`);
      console.log(`   Completed orders: ${batch.completed?.length || 0}`);
      console.log(`   Upload task sent: ${batch.uploadTaskSent || false}`);
      console.log(`   Upload sent at: ${batch.uploadTaskSentAt || 'N/A'}`);
    });

    // 7. Kiểm tra batches có thể upload ngay bây giờ
    const uploadableBatches = await ShippingBatch.find({
      machineId: shopId,
      status: 'CONFIRM_FILE_READY',
      completed: { $exists: true, $ne: [] },
      uploadTaskSent: { $ne: true }
    }).lean();

    console.log(`\n🚀 Currently uploadable batches: ${uploadableBatches.length}`);
    
    if (uploadableBatches.length > 0) {
      console.log('\n📦 Uploadable batches details:');
      uploadableBatches.forEach((batch, index) => {
        console.log(`${index + 1}. ${batch._id} - ${batch.completed.length} orders`);
      });
    } else {
      console.log('\n✅ No batches need uploading for this shop');
      console.log('   Reasons could be:');
      console.log('   - All batches already sent (uploadTaskSent: true)');
      console.log('   - No batches with completed data');
      console.log('   - Batches not in CONFIRM_FILE_READY status');
    }

    // 8. Kiểm tra batches được gửi gần đây
    const recentSentBatches = await ShippingBatch.find({
      machineId: shopId,
      uploadTaskSent: true,
      uploadTaskSentAt: { $exists: true }
    })
    .sort({ uploadTaskSentAt: -1 })
    .limit(3)
    .lean();

    if (recentSentBatches.length > 0) {
      console.log('\n📡 Recently sent batches:');
      recentSentBatches.forEach((batch, index) => {
        console.log(`${index + 1}. ${batch._id} - sent at ${batch.uploadTaskSentAt}`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

// Run the check
checkShopBatches();