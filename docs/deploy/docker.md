# Deploying FeedLog with Docker

This is the recommended path for self-hosting — one container, your own
Postgres, your own blob storage. Works on any Linux host, NAS, or
Docker-based PaaS (Coolify, Dokploy, Portainer, etc.).

## What you need

- A Linux host with Docker 20.10+
- A **Postgres 17+** with the `vector` extension (for AI features)
- Any **S3-compatible blob storage** (AWS S3, Cloudflare R2, MinIO, Alibaba
  OSS, Backblaze B2, …) if you want to allow file uploads on feedback posts.
  Leave unset to use ephemeral local filesystem storage.

## Image

Official multi-arch image (linux/amd64 + linux/arm64):

```
ghcr.io/linkcraftstudio/feedlog:latest
```

Tags:

- `latest` — most recent `main` build
- `v0.1.0` (and future `vX.Y.Z`) — release versions
- `sha-<short>` — immutable per-commit tag, recommended for production pinning

## Minimal single-command run

```bash
docker run -d --name feedlog -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@host:5432/feedlog" \
  -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e SYSTEM_ADMIN_EMAILS="admin@example.com" \
  -e BETTER_AUTH_URL="http://localhost:3000" \
  ghcr.io/linkcraftstudio/feedlog:latest
```

On first start, the container automatically runs database migrations against
`DATABASE_URL` before serving traffic. Expect a ~5-second delay on first boot
while the schema is created.

Visit `http://localhost:3000` — the app is ready.

## Full stack via the bundled `compose.yml`

The repo ships a [`compose.yml`](../../compose.yml) that brings up the
app plus a `pgvector`-enabled Postgres. Three lines to start:

```bash
git clone https://github.com/linkcraftstudio/feedlog.git && cd feedlog
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" > .env
echo "SYSTEM_ADMIN_EMAILS=you@example.com" >> .env
docker compose up -d
```

App at `http://localhost:3000`. Optional variables (OAuth, AI,
transactional email) can be added to the same `.env` — `compose.yml`
passes them through to the app container.

The shipped `compose.yml` is intentionally minimal — single replica,
default Postgres password, port `3000:3000` exposed to the host. For
production behind a reverse proxy / TLS terminator, copy it to
`compose.override.yml` and adjust:

- Bind app to a private network only (drop the public `ports:` mapping)
- Rotate `POSTGRES_PASSWORD` and update `DATABASE_URL` to match
- Add a backup sidecar or external Postgres
- Pin to a `sha-<short>` image tag for reproducibility

## Environment variables

See the **[configuration reference](../configuration.md)** for the full
list grouped by purpose, or [`.env.example`](../../.env.example) for the
annotated source. Quick reference:

| Variable | Required? | Purpose |
|----------|:---------:|---------|
| `DATABASE_URL` | ✅ | Postgres connection string |
| `BETTER_AUTH_SECRET` | ✅ | 32+ char session encryption secret |
| `SYSTEM_ADMIN_EMAILS` | ✅ | Comma-separated — these users get admin role on first sign-up. Without it the install has no admin. |
| `BETTER_AUTH_URL` | ⬜ | Public URL of the app (no trailing slash). Usually inferred, but set it behind Host-rewriting proxies or when OAuth/email links need a fixed origin. |
| `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` + `S3_BUCKET` (+ `S3_ENDPOINT` / `S3_REGION`) | ⬜ for persistent off-host uploads | Enables S3-compatible blob storage at runtime. See [Enabling S3 storage](#enabling-s3-compatible-storage-runtime). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ⬜ | Enable Google OAuth |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | ⬜ | Enable GitHub OAuth |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | ⬜ | Enable similar-idea merge and AI changelog drafting |
| `EMAIL_PROVIDER` / `RESEND_API_KEY` / `EMAIL_FROM` | ⬜ | Transactional email |

### Enabling S3-compatible storage (runtime)

The `modules/blob-s3` Nuxt module registers an S3-compatible blob
provider when the relevant env vars are present. Works with the
official image — no rebuild needed.

Set in `.env` (or `-e` flags):

```bash
# Required (always 3)
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=feedlog

# Plus AT LEAST ONE of:
S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com   # non-AWS services
S3_REGION=oss-cn-hangzhou                          # AWS or strict-region service
```

For providers that require virtual-hosted style, keep `S3_BUCKET` set
and use the bucket endpoint directly, for example
`S3_ENDPOINT=https://<bucket>.oss-cn-hangzhou.aliyuncs.com`.

Restart the container; on boot the plugin logs
`Registered blob provider: s3 (bucket=...)`. Rotation is just an
`.env` edit + restart.

Service-specific endpoint / region pairs (Cloudflare R2, Alibaba OSS,
Tencent COS, MinIO, Backblaze B2, Wasabi, Qiniu, ...) are listed in the
[configuration reference](../configuration.md#s3-compatible-storage).

Without these vars, uploads fall through to NuxtHub's local-filesystem
driver (writes to `/app/.data/blob`). The bundled `compose.yml` mounts
an `app-data` named volume on `/app/.data` so local uploads survive
container restarts. Single-host only — no multi-replica or cross-host
sharing.

## Health check

The container exposes a standard liveness probe at `/health`:

```bash
$ curl -s http://localhost:3000/health
{"status":"ok","timestamp":"2026-04-22T07:11:27.241Z"}
```

Kubernetes liveness probe example:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 20
```

## Upgrading

Migrations run automatically on container start. To upgrade:

```bash
docker pull ghcr.io/linkcraftstudio/feedlog:latest
docker stop feedlog && docker rm feedlog
# ...re-run with the same env vars
```

Pin to a specific version tag (e.g. `v0.1.0`) in production to avoid
surprise updates.

## Common issues

### `Database migration failed: ... vector extension does not exist`

Your Postgres image doesn't have `pgvector`. Use `pgvector/pgvector:pg17` (or
later) instead of the stock `postgres` image, or install the extension manually:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Container starts but `/health` 500s / `/api/boards` 500s

Check `docker logs feedlog`. Most common cause: `DATABASE_URL` points at a
host the container can't reach. If using docker-compose, use the service
name (`db`), not `localhost`.

### Upload fails with "no such host"

Verify `S3_ENDPOINT` is reachable from inside the container (try
`docker compose exec app wget -O- $S3_ENDPOINT`). Also confirm the
bucket permits the `PutObject` and `GetObject` actions for the
credentials supplied. Check container logs for the
`Registered blob provider: s3 (bucket=..., endpoint=...)` line on
startup — if missing, one of `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`
/ `S3_BUCKET` is empty.

### How to reset everything

```bash
docker compose down -v   # -v drops the Postgres volume
docker compose up -d
```

## Next steps

- **[Cloudflare Workers deploy](./cloudflare-workers.md)** — serverless edge deploy
- **[Vercel deploy](./vercel.md)** — managed Node.js deploy with zero config
