/* eslint-disable no-console */
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
require("./src/config/env.config")();
require("./src/helper/consoleGuard").installConsoleGuard();

const http = require("http");
const connectDB = require("./src/config/db.config");
const registerSocketHandlers = require("./src/socket/index");
const presence = require("./src/lib/presence");
const etsyVendorSyncScheduler = require("./src/service/etsyVendorSyncScheduler");
const { startAutoScheduler } = require("./src/controllers/autoConfig.controller");

// ===== App
const app = express();
app.set("trust proxy", true);
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf || "");
  },
}));
if (process.env.NODE_ENV !== "production" || process.env.LOG_HTTP_ACCESS === "true") {
  app.use(morgan("dev"));
}

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
  realtimeLogRoutes,
  teamRoutes,
  extRoutes,
  adminSessionRoutes,
  PointsRoutes,
  ShippingBatchRoutes,
  ToDoListRoutes,
  EtsyOrderRoutes,
  EtsyListingRoutes,
  EtsyMessagesRoutes,
  autoConfigRoutes,
  extensionLogRoutes,
  etsyAdsRoutes,
  vendorWebhookRoutes,
  devRoutes,
  shopifyRoutes,
  orderLifecycleRoutes
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
app.use("/api/admin", adminSessionRoutes);
app.use("/api/points", PointsRoutes);
app.use("/api/shipping-batch", ShippingBatchRoutes);
app.use("/api/shipping-batches", ShippingBatchRoutes); // ✅ Alias để hỗ trợ cả hai
app.use("/api/to-do", ToDoListRoutes);
app.use("/api/etsy", EtsyOrderRoutes);
app.use("/api/etsy-listing", EtsyListingRoutes);
app.use("/api/etsy-messages", EtsyMessagesRoutes);
app.use("/api/etsy-ads", etsyAdsRoutes);
app.use("/api/auto-config", autoConfigRoutes);
app.use("/api/ext/logs", extensionLogRoutes);
app.use("/api/vendor-webhooks", vendorWebhookRoutes);
app.use("/api/dev", devRoutes);
app.use("/api/shopify", shopifyRoutes);
app.use("/api/order-lifecycle", orderLifecycleRoutes);

app.use("/api/r2-test", require("./src/routes/upload.router.R2"));
// ===== HTTP server
const httpServer = http.createServer(app);

httpServer.requestTimeout = 0;
httpServer.timeout = 0;
httpServer.headersTimeout = 320000;

// ===== Socket.IO (khởi tạo gọn)
const { Server } = require("socket.io");
const io = new Server(httpServer, {
  path: "/ws",
  transports: ["websocket", "polling"], // cho fallback an toàn
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false,
  },
  pingInterval: 25000,
  pingTimeout: 20000,
});

function shutdown() {
  try {
    etsyVendorSyncScheduler.stop();
  } catch { }
  try {
    io.close();
  } catch { }
  try {
    httpServer.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Cho các nơi khác (routes) lấy ra dùng
app.set("io", io);
app.set("ackMap", new Map());
app.set("presence", presence);

registerSocketHandlers({ app, io });
app.use("/api/ext", extRoutes);

// // ===== Khởi tạo Cron Jobs
// const cronJobService = require("./src/service/cronJobs");
// cronJobService.setSocketIO(io); // Truyền Socket.IO instance vào cron jobs
// cronJobService.initializeJobs();

// // Graceful shutdown cho cron jobs
// const originalShutdown = shutdown;
// function shutdown() {
//   console.log('� [CRON] Stopping all cron jobs...');
//   cronJobService.stopAllJobs();
//   originalShutdown();
// }

// ===== Error handler
app.use((err, _req, res, _next) => {
  res
    .status(err.status || 500)
    .json({ error: { message: err.message || "Internal Server Error" } });
});

const PORT = process.env.PORT || 5000;
connectDB().then(() => {
  etsyVendorSyncScheduler.start();
  startAutoScheduler();
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.info(`API running at http://localhost:${PORT}`);
  });
});
