const Sentry = require("@sentry/node");

function initSentry() {
  if (!process.env.SENTRY_DSN) return false;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    sendDefaultPii: false,
  });

  return true;
}

module.exports = {
  Sentry,
  initSentry,
};
