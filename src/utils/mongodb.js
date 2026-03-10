const mongoose = require('mongoose');

const connectToDatabase = async () => {
    const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/auth_demo';

    await mongoose.connect(mongoURI, {});

    console.log('✅ MongoDB connected successfully');
};

module.exports = connectToDatabase;

