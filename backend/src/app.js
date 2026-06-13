require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const path = require("path");
const crypto = require("crypto");
const { requestLogger } = require("./config/logger");
const { initSentry } = require("./config/sentry");
const { metricsMiddleware, metricsHandler } = require("./config/metrics");
const { mountSwagger } = require("./config/swagger");

/* ==== Route imports ==== */
const homeRoutes = require("./routes/homeRoutes");
const authRoutes = require("./routes/authRoutes");
const productRoutes = require("./routes/productRoutes");
const productVariantRoutes = require("./routes/productVariantRoutes");
const productAdminRoutes = require("./routes/productAdminRoutes");
const userRoutes = require("./routes/userRoutes");
const addressRoutes = require("./routes/addressRoutes");
const bankRoutes = require("./routes/bankRoutes");
const voucherRoutes = require("./routes/voucherRoutes");
const bannerRoutes = require("./routes/bannerRoutes");
const cartRoutes = require("./routes/cartRoutes");
const checkoutRoutes = require("./routes/checkoutRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const orderRoutes = require("./routes/orderRoutes");
const shippingRoutes = require("./routes/shippingRoutes");
const flashSaleRoutes = require("./routes/flashsaleRoutes");
const walletRoutes = require("./routes/walletRoutes");
const refundRoutes = require("./routes/refundRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const shopRoutes = require("./routes/shopRoutes");
const vendorShopRoutes = require("./routes/vendorShopRoutes");
const transactionRoutes = require("./routes/transactionRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const ticketRoutes = require("./routes/ticketRoutes");
const notificationRoutes     = require("./routes/notificationRoutes");
const adminProductRoutes     = require("./routes/adminProductRoutes");
const conversationRoutes     = require("./routes/conversationRoutes");
const shopConversationRoutes = require("./routes/shopConversationRoutes");
const uploadRoutes           = require("./routes/uploadRoutes");
// const adminRoutes = require("./routes/adminRoutes");

const errorMiddleware = require("./middlewares/errorMiddleware");

const FE_ORIGIN = process.env.FE_ORIGIN || "http://localhost:5173";

const app = express();
initSentry();

app.use((req, res, next) => {
  req.id = req.get("x-request-id") || crypto.randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
});



/* ==== FIX 1: COOP Header ============================================
   "same-origin" (helmet default) chặn window.postMessage của Google
   OAuth popup → lỗi "Cross-Origin-Opener-Policy would block postMessage"
   Phải set "same-origin-allow-popups" cho route auth, còn lại giữ
   "same-origin" để bảo mật.
================================================================== */
app.use((req, res, next) => {
  if (req.path.startsWith("/api/auth")) {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  } else {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  }
  next();
});

/* ==== Security & CORS ==== */
// FIX: crossOriginOpenerPolicy: false vì ta tự set thủ công ở trên
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: false, // tắt để không bị helmet ghi đè
}));
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
app.use(
  cors({
    origin: [FE_ORIGIN],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/* ==== Disable 304 caching for API ==== */
app.set("etag", false);
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

/* ==== Parsers & Performance ==== */
// FIX 2: Tăng limit json lên 10mb để chứa Google ID token (~2KB) và
// các payload lớn khác, tránh bị reject trước khi xử lý
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(compression());
app.use(requestLogger);
app.use(metricsMiddleware);
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: "Too many requests, please try again later.",
  })
);

mountSwagger(app);
app.get("/metrics", metricsHandler);

/* ==== Webhook routes (no auth — must be before auth middleware) ==== */
app.post("/api/webhooks/ghn", require("./controllers/shopOrderController").handleGhnWebhook);

/* ==== Routes ==== */
app.use("/api", homeRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/product-variant", productVariantRoutes);
app.use("/api/users", userRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/banks", bankRoutes);
app.use("/api/vouchers", voucherRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/shipping/webhooks", shippingRoutes);
app.use("/api/flashsales", flashSaleRoutes);
app.use("/api/wallets", walletRoutes);
app.use("/api/refunds", refundRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/shop/admin",         productAdminRoutes);     // must be before /api/shop
app.use("/api/shop/conversations", shopConversationRoutes);  // must be before /api/shop
app.use("/api/shop",               shopRoutes);
app.use("/api/vendor/shops",       vendorShopRoutes);
app.use("/api/transactions",       transactionRoutes);
app.use("/api/analytics",          analyticsRoutes);
app.use("/api/tickets",            ticketRoutes);
app.use("/api/notifications",      notificationRoutes);
app.use("/api/conversations",      conversationRoutes);
app.use("/api/uploads",            uploadRoutes);
app.use("/api/size-charts",  require("./routes/sizeChartRoutes"));
app.use("/api/admin/products",      adminProductRoutes);
app.use("/api/admin/moderation",    require("./routes/adminModerationRoutes"));
app.use("/api/admin/moderate",      require("./routes/moderationRoutes"));
app.use("/api/reports",             require("./routes/reportRoutes"));
app.use("/api/admin/users",         require("./routes/adminUserRoutes"));
app.use("/api/admin/audit-logs",    require("./routes/auditLogRoutes"));
app.use("/api/admin/api-keys",      require("./routes/apiKeyRoutes"));
app.use("/api/admin/system-config", require("./routes/systemConfigRoutes"));
app.use("/api/admin/env-config",    require("./routes/envRoutes"));
app.use("/api/admin/finance",       require("./routes/adminFinanceRoutes"));
app.use("/api/admin/tickets",       require("./routes/adminTicketRoutes"));
// app.use("/api/admin", adminRoutes);

app.use("/static/invoices", express.static(path.join(__dirname, "../public/invoices")));

/* ==== Health ==== */
app.get("/", (req, res) => {
  res.status(200).json({
    message: "✅ DFS Backend API is running...",
    version: "1.0.0",
    time: new Date().toISOString(),
  });
});

app.get("/healthz", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime(), time: new Date().toISOString() });
});

/* ==== Error ==== */
app.use(errorMiddleware);

module.exports = app;
