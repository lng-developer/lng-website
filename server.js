/* eslint-disable no-console */
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const http = require("http");
const connectDB = require("./src/config/db.config");
const registerSocketHandlers = require("./src/core/socket");
const presence = require("./src/core/presence");
const logger = require("./src/middleware/logger");
const requestLogger = require("./src/middleware/requestLogger");
const errorHandler = require("./src/middleware/errorHandler");

// ===== App
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" }));
app.use(requestLogger);
app.use(cors());

// Health
app.get("/", (_req, res) =>
  res.json({ message: "Welcome to RESTful API - Node.js" })
);

// ===== Existing routes (giữ nguyên)
// ===== Modular Routes
const {
  authModule,
  catalogModule,
  fulfillmentModule,
  orderModule,
  reportModule,
  systemModule,
  taskModule,
  teamModule,
  vendorModule,
} = require("./src/routes");

app.use(authModule);
app.use(catalogModule);
app.use(fulfillmentModule);
app.use(orderModule);
app.use(reportModule);
app.use(systemModule);
app.use(taskModule);
app.use(teamModule);
app.use(vendorModule);


// ===== HTTP server
const httpServer = http.createServer(app);

httpServer.requestTimeout = 300000; // 300s
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
// app.use("/api/ext", extRoutes); // Already in systemModule

// ===== Error handler (centralized)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
connectDB();
httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`🚀 API running at http://localhost:${PORT}`);
});
