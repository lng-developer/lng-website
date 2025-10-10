/* eslint-disable no-console */
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const connectDB = require("./src/config/db.config");
const http = require("http");

// ===== App
const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(morgan("dev"));
app.use(cors());

app.get("/", (_req, res) =>
  res.json({ message: "Welcome to RESTful API - Node.js" })
);

// ===== Your existing routes (giữ nguyên)
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
  realtimeLogRoutes,
  jobRoutes,
  adminRoutes,
  realtimeRoutes,
  clientsRoutes,
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

// ===== New routes (jobs / admin / realtime / clients)
app.use("/jobs", jobRoutes);
app.use("/admin", adminRoutes);
app.use("/logs", realtimeRoutes);
app.use("/clients", clientsRoutes);

// Error handler
app.use((err, _req, res, _next) => {
  res
    .status(err.status || 500)
    .json({ error: { message: err.message || "Internal Server Error" } });
});

// ===== HTTP + Socket.IO
const httpServer = http.createServer(app);
const { initSocket } = require("./src/socket");
initSocket(httpServer);

// ===== DB + Scheduler
const {
  start: schedStart,
  scheduler,
} = require("./src/service/scheduler.service");

const PORT = process.env.PORT || 5000;
connectDB();
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API + Socket.IO on http://localhost:${PORT} (path /socket)`);
  if (process.env.AUTO_START_FIXED === "1") {
    scheduler.enabled = true;
    schedStart();
  }
});
