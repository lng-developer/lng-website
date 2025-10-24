/* eslint-disable no-console */
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const http = require("http");
const connectDB = require("./src/config/db.config");

// ===== App
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));
app.use(cors());

// Health
app.get("/", (_req, res) =>
  res.json({ message: "Welcome to RESTful API - Node.js" })
);

// ===== Existing routes (giữ nguyên)
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
  ideaTaskRoutes,
  realtimeLogRoutes, // vẫn có thể dùng lại để FE xem /logs (activity)
  teamRoutes
} = require("./src/routes");

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
app.use("/api/idea-task", ideaTaskRoutes);
app.use("/api/logs", realtimeLogRoutes);
app.use("/api/teams", teamRoutes);

app.use((err, _req, res, _next) => {
  res
    .status(err.status || 500)
    .json({ error: { message: err.message || "Internal Server Error" } });
});

// ===== HTTP server (không Socket.IO)
const httpServer = http.createServer(app);

const PORT = process.env.PORT || 5000;
connectDB();
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API running at http://localhost:${PORT}`);
});
