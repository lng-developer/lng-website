const mongoose = require('mongoose');
require('dotenv').config();

const ConfigAuto = require('./src/models/configAuto.model');

async function testProductionAuto() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: process.env.DB_NAME,
    });
    console.log('✅ Connected to MongoDB');

    // Test gọi API trực tiếp
    const axios = require('axios');
    const baseURL = process.env.BASE_URL || 'http://localhost:5000';
    
    console.log('🧪 Testing autoRequestExtensionAll API directly...');
    
    try {
      const response = await axios.post(`${baseURL}/api/ext/request-extension/auto-all`, {
        type: 'IMPORT_ORDERS',
        payload: null,
        action: 'test',
        label: 'Production Test'
      });
      
      console.log('✅ API Response:', {
        status: response.status,
        ok: response.data.ok,
        processed: response.data.processed,
        success: response.data.success,
        failed: response.data.failed,
        duration: response.data.duration
      });
      
      if (response.data.results && response.data.results.length > 0) {
        console.log('\n📊 Sample results:');
        response.data.results.slice(0, 3).forEach(result => {
          console.log(`   ${result.success ? '✅' : '❌'} ${result.shopName}: ${result.message}`);
        });
      }
      
    } catch (error) {
      if (error.response) {
        console.error('❌ API Error:', error.response.status, error.response.data);
      } else {
        console.error('❌ Network Error:', error.message);
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

console.log('🚀 Testing production auto...');
testProductionAuto();