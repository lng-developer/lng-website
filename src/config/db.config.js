// Update back_end/src/config/db.config.js
const mongoose = require('mongoose');
const connectToDatabase = require('../utils/mongodb');

mongoose.Promise = global.Promise;

const connectDB = async () => {
    try {
        await connectToDatabase();
    } catch (error) {
        console.error('Database connection error:', error.message);
        // Don't call process.exit() in serverless environments
    }
};

module.exports = connectDB;
