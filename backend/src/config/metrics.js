const client = require("prom-client");

client.collectDefaultMetrics({
  prefix: "dfs_",
});

const httpRequestDuration = new client.Histogram({
  name: "dfs_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

const httpRequestsTotal = new client.Counter({
  name: "dfs_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
});

function routeLabel(req) {
  return req.route?.path
    ? `${req.baseUrl || ""}${req.route.path}`
    : req.originalUrl?.split("?")[0] || req.path || "unknown";
}

function metricsMiddleware(req, res, next) {
  if (req.path === "/metrics") return next();
  const end = httpRequestDuration.startTimer();

  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status_code: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    end(labels);
  });

  next();
}

async function metricsHandler(req, res) {
  const token = process.env.METRICS_TOKEN;
  if (token && req.get("authorization") !== `Bearer ${token}`) {
    return res.status(401).send("Unauthorized");
  }
  res.set("Content-Type", client.register.contentType);
  return res.end(await client.register.metrics());
}

module.exports = {
  client,
  metricsMiddleware,
  metricsHandler,
};
