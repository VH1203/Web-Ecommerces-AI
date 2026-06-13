# DFS Deployment Guide

## Environment

Create `backend/.env.production` from `backend/.env.production.example`. Do not commit this file.

Backend production variables should include:

```env
NODE_ENV=production
PORT=5000
FE_ORIGIN=https://example.com
API_PUBLIC_URL=https://api.example.com/api
MONGO_URI=mongodb://mongo:27017/WDP
REDIS_URL=redis://redis:6379
JWT_SECRET=change-me
JWT_REFRESH_SECRET=change-me
SENTRY_DSN=
METRICS_TOKEN=
GHN_TOKEN=
GHN_SHOP_ID=
GHN_DEV_MODE=false
MONGO_TRANSACTIONS=false
```

Set `MONGO_TRANSACTIONS=true` only when MongoDB runs as a replica set or Atlas cluster.

Frontend production variables:

```env
VITE_API_URL=https://api.example.com/api
VITE_SOCKET_URL=https://api.example.com
VITE_SENTRY_DSN=
VITE_SENTRY_TRACES_SAMPLE_RATE=0.1
```

## Local Docker Compose

```bash
docker compose up -d --build
docker compose logs -f backend
```

Services:

- Frontend: `http://localhost`
- Backend through Nginx: `http://localhost/api`
- Swagger: `http://localhost/api/docs`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`

## Nginx

The included Nginx config is in `infra/nginx`. Replace `example.com`, `www.example.com`, and `api.example.com` with your real domains.

For HTTPS, put certificates in `infra/nginx/certs` or let Cloudflare terminate TLS and keep origin restricted to Cloudflare IPs. If you terminate TLS at Nginx, add a `listen 443 ssl http2;` server block and configure `ssl_certificate` / `ssl_certificate_key`.

## GitHub Actions CI/CD

Required repository secrets for deploy:

- `DEPLOY_HOST`: server IP or hostname
- `DEPLOY_USER`: SSH user
- `DEPLOY_SSH_KEY`: private SSH key
- `DEPLOY_PATH`: project path on server

Server setup once:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git
git clone <repo-url> /opt/dfs
cd /opt/dfs
cp backend/.env.production.example backend/.env.production
nano backend/.env.production
docker compose up -d --build
```

After that, pushing to `main` triggers `.github/workflows/deploy.yml`.
