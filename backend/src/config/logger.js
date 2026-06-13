const fs = require("fs");
const path = require("path");
const { createLogger, format, transports } = require("winston");
const morgan = require("morgan");

const logDir = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const redactKeys = ["password", "password_hash", "token", "authorization", "api_key", "secret", "refresh_token"];

function redact(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key,
      redactKeys.some((needle) => key.toLowerCase().includes(needle)) ? "[REDACTED]" : redact(val),
    ])
  );
}

const logger = createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  defaultMeta: {
    service: process.env.SERVICE_NAME || "dfs-backend",
    env: process.env.NODE_ENV || "development",
  },
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format((info) => {
      if (info.metadata) info.metadata = redact(info.metadata);
      return info;
    })(),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: process.env.NODE_ENV === "production"
        ? format.json()
        : format.combine(format.colorize(), format.simple()),
    }),
    new transports.File({ filename: path.join(logDir, "error.log"), level: "error" }),
    new transports.File({ filename: path.join(logDir, "combined.log") }),
  ],
});

const requestLogger = morgan("combined", {
  stream: {
    write: (message) => logger.http(message.trim()),
  },
  skip: (req) => req.path === "/metrics" || req.path === "/healthz",
});

module.exports = {
  logger,
  requestLogger,
  redact,
};
