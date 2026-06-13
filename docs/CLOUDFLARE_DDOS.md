# Cloudflare DDoS Setup

Cloudflare cannot be fully configured from this repository, but the app is prepared to sit behind it.

## DNS

Create proxied records:

- `example.com` -> server IP, orange cloud on
- `www.example.com` -> server IP, orange cloud on
- `api.example.com` -> server IP, orange cloud on

## SSL/TLS

Use `Full (strict)` when the origin has a valid certificate. Use Cloudflare Origin Certificate or Let's Encrypt on the server.

## WAF and Rate Limits

Create rate limit/WAF rules for:

- `/api/auth/login`
- `/api/auth/register/request-otp`
- `/api/auth/forgot-password/request-otp`
- `/api/checkout/*`
- `/api/payment/*`
- `/api/wallets/deposit/*`

Suggested starting point:

- Auth/OTP: 5 requests per minute per IP
- Checkout/payment: 20 requests per minute per IP
- Challenge suspicious countries/ASNs only if your real customers are not affected

## WebSocket

Cloudflare supports Socket.IO/WebSocket. Keep WebSockets enabled and proxy:

- `https://api.example.com/socket.io/`
- `https://api.example.com/realtime/`

## Protect Origin IP

The important part: do not allow direct traffic to the server.

On the server firewall, allow ports `80/443` only from Cloudflare IP ranges, plus SSH from your own IP. Cloudflare publishes the current ranges here:

- https://www.cloudflare.com/ips-v4/
- https://www.cloudflare.com/ips-v6/

Example with UFW after adding Cloudflare ranges:

```bash
sudo ufw default deny incoming
sudo ufw allow from <your-ip> to any port 22 proto tcp
sudo ufw allow from <cloudflare-ip-range> to any port 80 proto tcp
sudo ufw allow from <cloudflare-ip-range> to any port 443 proto tcp
sudo ufw enable
```

## Recommended Cloudflare Settings

- Security Level: Medium
- Bot Fight Mode: On
- WAF Managed Rules: On
- Browser Integrity Check: On
- Always Use HTTPS: On
- Cache static assets: On
- Development Mode: Off in production

Use Cloudflare Turnstile for login/register if OTP or login gets bot spam.
