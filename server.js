const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();
const path = require('path');
const connectDB = require('./src/config/db.config');
const { roleRoutes, userRoutes, accountRoutes, authRoutes, orderCustomProductRoutes, shopRoutes } = require('./src/routes');

const app = express();
app.use(express.json());
app.use(morgan('dev'));
app.use(cors());

// Root Route
app.get('/', (req, res) => {
    res.json({ message: 'Welcome to RESTful API - Node.js' });
});

// API Routes
app.use('/api/role', roleRoutes);
app.use('/api/user', userRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/order', orderCustomProductRoutes);
app.use('/api/shop', shopRoutes);
app.use('/uploads', express.static(path.join(__dirname, 'src/public/uploads')));


// Error Handler
app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
        error: { message: err.message || 'Internal Server Error' }
    });
});

// Run Server
const PORT = process.env.PORT || 5000;
connectDB();
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
