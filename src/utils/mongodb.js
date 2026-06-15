const mongoose = require('mongoose');

const connectToDatabase = async () => {
    const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/auth_demo';

    const options = {};
    if (process.env.DB_NAME) options.dbName = process.env.DB_NAME;

    await mongoose.connect(mongoURI, options);

    console.log('✅ MongoDB connected successfully');
};

module.exports = connectToDatabase;
