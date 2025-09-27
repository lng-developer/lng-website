const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();
const path = require("path");
const connectDB = require("./src/config/db.config");
const {
  roleRoutes,
  userRoutes,
  accountRoutes,
  authRoutes,
  orderCustomProductRoutes,
  shopRoutes,
  vendorRoutes,
  vendorProductRoutes,
  vendorCostCenterRoutes,
  caseRoutes,
  listingRoutes,
  productTypeRoutes,
  configCostCenterRoutes,
  configOptionMappingRoutes,
  scaleRoutes,
  QCRoutes,
  reportRoutes,
  adsRoutes,
  skuMappingRoutes,
  APORoutes,
  PsdTaskRoutes,
} = require("./src/routes");

const app = express();
app.use(express.json());
app.use(morgan("dev"));
app.use(cors());

// Root Route
app.get("/", (req, res) => {
  res.json({ message: "Welcome to RESTful API - Node.js" });
});

// API Routes
app.use("/api/role", roleRoutes);
app.use("/api/user", userRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/order", orderCustomProductRoutes);
app.use("/api/shop", shopRoutes);
app.use("/api/vendor", vendorRoutes);
app.use("/api/vendor-product", vendorProductRoutes);
app.use("/api/vendor-cost-center", vendorCostCenterRoutes);
app.use("/api/case", caseRoutes);
app.use("/api/listing", listingRoutes);
app.use("/api/product-type", productTypeRoutes);
app.use("/api/config-cost-center", configCostCenterRoutes);
app.use("/api/scale", scaleRoutes);
app.use("/api/fulfillment/qc", QCRoutes);
app.use("/api/mapping", configOptionMappingRoutes);
app.use("/api/report", reportRoutes);
app.use("/api/ads", adsRoutes);
app.use("/api/sku-mapping", skuMappingRoutes);
app.use("/APO", APORoutes);
app.use("/api/psd-task", PsdTaskRoutes);

// Error Handler
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({
    error: { message: err.message || "Internal Server Error" },
  });
});

// Run Server
const PORT = process.env.PORT || 5000;
connectDB();
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
