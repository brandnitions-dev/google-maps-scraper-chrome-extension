# VPS deploy (isolated Docker)

This stack runs **only** the Gmaps enrich API (Python + Playwright) and a small **Next.js admin** UI on a private Docker bridge network. It does **not** change existing nginx files or other projects on the host.

## Ports (defaults)

| Service | Inside stack | Published (host) default |
|--------|----------------|---------------------------|
| API    | `api:18765`    | `31876` → `18765`         |
| Admin UI | `web:3000` | `31877` → `3000`         |

Before first run, confirm ports are free on the VPS:

```bash
ss -tlnp | grep -E '31876|31877' || true
```

Edit `docker-compose.yml` port mappings if `31876` / `31877` conflict on the host (e.g. bind `127.0.0.1:31876:18765` only).

## One-time setup

1. Install Docker + Compose plugin on the VPS.
2. Copy this `deploy/vps` folder (including `admin-ui`) and `GmapsAgent/EmailEnricher` to the server **or** copy the whole `GmapsAgent` tree so paths match `docker-compose.yml` build contexts.
3. Create `.env` from `.env.example` and set:
   - `ADMIN_PASSWORD_BCRYPT` — bcrypt hash of the admin password (see `.env.example`).
   - `JWT_SECRET` — long random secret (32+ characters).

**Important:** bcrypt strings contain `$`. Docker Compose treats `$` in `.env` as variable interpolation. **Double every `$`** in `ADMIN_PASSWORD_BCRYPT` when editing `.env` by hand (e.g. `$2b$12$…` → `$$2b$$12$$…`), or use the provided deploy script which does this automatically.

## Run

From `deploy/vps`:

```bash
docker compose --env-file .env up -d --build
```

Smoke tests:

```bash
curl -sS "http://127.0.0.1:31876/health"
```

Open admin UI: `http://YOUR_VPS_IP:31877` → login → create API key.

## Troubleshooting

### Blank white page (connection works)

- Hard-refresh (Ctrl+F5). Open **DevTools → Network**: every `/_next/static/...` script should be **200**. If any are blocked or redirected, fix your reverse proxy / WAF (must pass through `_next` paths unchanged).
- On the **VPS**, from SSH: `curl -sI http://127.0.0.1:31877/login` — you should see `200` and `text/html`. Then: `curl -s http://127.0.0.1:31877/api/health` → `{"ok":true,"service":"gmaps-enrich-admin"}`.
- Rebuild admin only: `docker compose build web --no-cache && docker compose up -d web`.
- Logs: `docker logs gmaps_enrich_admin --tail 100`.

### `ERR_CONNECTION_TIMED_OUT` from your PC

- The host firewall or cloud **security group** is blocking **31877** (and **31876** for the API). Open inbound TCP for your IP (or temporarily `0.0.0.0/0` for testing).
- On the server: `ss -tlnp | grep 31877` — Docker should listen. `docker ps` — both `gmaps_enrich_admin` and `gmaps_enrich_api` **Up**.

## Firewall

Prefer restricting access to your IP, e.g.:

```bash
sudo ufw allow from YOUR_IP to any port 31876 proto tcp
sudo ufw allow from YOUR_IP to any port 31877 proto tcp
```

## Data

SQLite lives in Docker volume `gmaps_enrich_sqlite` (API keys). Back up with `docker run ...` volume copy or `docker cp` from the container after stop.

## Playwright / memory

The API image is based on Microsoft’s Playwright Python image. If Chromium crashes, increase `shm_size` in `docker-compose.yml` (already `1gb`).

## Extension

Point the extension at `http://YOUR_VPS_IP:31876`, paste an API key, **Test connection**, **Save**, then grant host permission if Chrome prompts.
