// src/server.js
require("dotenv").config();
const http = require("http");
const app = require("./app");
const { logger } = require("./config/logger");

const FE_ORIGIN = process.env.FE_ORIGIN || "http://localhost:5173";
const PORT = process.env.PORT || 5000;

// Tạo httpServer từ app (thay vì app.listen)
// maxHeaderSize: tăng lên 64 KB để tránh 431 khi headers lớn
const server = http.createServer({ maxHeaderSize: 65536 }, app);

// === Socket.IO v4 gắn vào httpServer ===
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: FE_ORIGIN,
    credentials: true,
    methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  },
  // path: "/socket.io", // giữ mặc định để khớp client
});

// Namespace realtime + helper broadcast
const realtime = require("./sockets/realtime")(io);
// Cho controller lấy ra broadcast: req.app.get("realtime")
app.set("realtime", realtime);

// Wire socketManager so any service can emit user events
const socketManager = require("./config/socketManager");
socketManager.init(realtime.emitToUser);

// Moderation cron (auto-unban + violation detection)
const moderationCron = require("./cron/moderationCron");

// Kết nối DB + start
const { connectDB } = require("./config/db");
(async () => {
  try {
    await connectDB();
    server.listen(PORT, () => {
      logger.info(`API + Socket.IO listening on ${PORT}`);
    });

    // Start moderation background jobs after DB is connected
    moderationCron.start();
  } catch (err) {
    logger.error("Failed to start server", { error: err });
    process.exit(1);
  }
})();
