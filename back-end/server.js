const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// Kết nối MongoDB
mongoose.connect('mongodb://localhost:27017/lng-website', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('✅ Connected to MongoDB');
}).catch(err => {
    console.error('❌ MongoDB connection error:', err);
});

// Route mẫu
app.get('/', (req, res) => {
    res.send('Hello from Express.js + MongoDB!');
});

// Lắng nghe port
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
