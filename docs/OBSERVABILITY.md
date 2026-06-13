# Observability

## Swagger

OpenAPI UI is mounted at:

- `/api/docs`
- `/api/docs.json`

Add detailed endpoint annotations gradually in `backend/src/routes/*.js` or extend `backend/src/config/swagger.js`.

## Winston Logs

Logs are written to:

- `backend/logs/combined.log`
- `backend/logs/error.log`

Use `LOG_LEVEL=debug|info|warn|error`.

Sensitive fields such as password, token, authorization, secret, and api_key are redacted from structured metadata.

## Sentry

Backend:

```env
SENTRY_DSN=https://...
SENTRY_TRACES_SAMPLE_RATE=0.1
```

Frontend:

```env
VITE_SENTRY_DSN=https://...
VITE_SENTRY_TRACES_SAMPLE_RATE=0.1
```

Backend server errors are captured in `errorMiddleware`. Frontend Sentry initializes in `frontend/src/config/sentry.js`.

## Prometheus and Grafana

Metrics endpoint:

- `/metrics`

If `METRICS_TOKEN` is set, Prometheus must send `Authorization: Bearer <token>`.

Docker Compose starts Prometheus on `:9090` and Grafana on `:3001`.
