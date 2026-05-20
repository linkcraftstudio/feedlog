# Configuration reference

Complete list of environment variables FeedLog reads. For deploy-specific
guidance, see the [Cloudflare Workers](./deploy/cloudflare-workers.md),
[Vercel](./deploy/vercel.md), and [Docker](./deploy/docker.md) guides.

The annotated source of this list lives in [`.env.example`](../.env.example) —
it's safe to copy that file to `.env` and edit in place.

## Contents

- [Quick start: minimal config](#quick-start-minimal-config)
- [Core](#core)
- [Public URL](#public-url)
- [Authentication](#authentication)
- [Blob storage](#blob-storage)
- [AI features](#ai-features)
- [Transactional email](#transactional-email)
- [Platform notes](#platform-notes)

## Quick start: minimal config

Set these three variables and FeedLog boots with email + password login,
auto-seeded boards, and a welcome post:

```bash
DATABASE_URL=postgresql://user:pass@host:5432/feedlog
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
SYSTEM_ADMIN_EMAILS=you@example.com
```

Everything else is optional and unlocks specific capabilities (OAuth, AI,
file uploads, transactional email).

---

## Core

### `DATABASE_URL` &nbsp;✅ required

PostgreSQL 17+ connection string. The `vector` extension must be installed
in this database (`CREATE EXTENSION IF NOT EXISTS vector;`) — required for
similar-idea detection. Most managed providers (Neon, Supabase) enable it
via their UI.

```
postgresql://USER:PASSWORD@HOST:5432/DATABASE
```

For managed providers append `?sslmode=require`. On Cloudflare Workers
this variable is **replaced by the `POSTGRES` Hyperdrive binding** —
don't set it in `wrangler.toml`.

### `BETTER_AUTH_SECRET` &nbsp;✅ required

Session and cookie encryption secret. Must be 32+ random characters.
Generate with:

```bash
openssl rand -hex 32
```

Rotating this value invalidates every existing session.

### `SYSTEM_ADMIN_EMAILS` &nbsp;✅ required

Comma-separated list of emails granted admin role on first sign-up. Set
this **before the first sign-up** — without it, the install has no admin
user and you cannot manage boards or posts from the dashboard.

```
SYSTEM_ADMIN_EMAILS=founder@example.com,ops@example.com
```

The first sign-up that matches one of these emails is automatically
promoted via better-auth's admin plugin. Adding emails after the first
admin already exists is a no-op for existing users.

---

## Public URL

### `BETTER_AUTH_URL` &nbsp;⬜ optional

Public URL where FeedLog is served, no trailing slash. better-auth infers
this from the request `Host` header by default, which works for most
deploys (Vercel, direct Workers, single-domain Docker).

Set it explicitly when:

- The app is behind a proxy that rewrites the `Host` header
- OAuth callback URLs need a fixed origin (most providers do)
- Password-reset emails need to embed a stable absolute URL

```
BETTER_AUTH_URL=https://feedback.yourdomain.com
```

---

## Authentication

OAuth providers are independent — configure one, both, or neither. If
**no** OAuth is configured, email + password login is auto-enabled so a
fresh install is never locked out.

### `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` &nbsp;⬜ optional

Google OAuth credentials. Create them at
<https://console.cloud.google.com/apis/credentials>. The OAuth app's
authorized redirect URI must include:

```
<BETTER_AUTH_URL>/api/auth/callback/google
```

### `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` &nbsp;⬜ optional

GitHub OAuth credentials. Create them at
<https://github.com/settings/developers>. The OAuth app's callback URL
must be exactly:

```
<BETTER_AUTH_URL>/api/auth/callback/github
```

### `AUTH_EMAIL_ENABLED` &nbsp;⬜ optional

Force-toggle email + password login. Three states:

| Value | Behavior |
|-------|----------|
| _unset_ (default) | Auto-enabled iff no OAuth provider is configured |
| `true` | Force-enabled (allows email login alongside OAuth) |
| `false` | Force-disabled (OAuth-only — **don't set this without configuring OAuth first** or the install will be locked out) |

### `AUTH_EMAIL_VERIFY` &nbsp;⬜ optional

Force-toggle "verify email before sign-in".

| Value | Behavior |
|-------|----------|
| _unset_ (default) | Auto-enabled iff a real email provider is configured (`RESEND_API_KEY` set) |
| `true` | Force-enabled (verification email is sent on signup; requires a working email provider, otherwise signup fails) |
| `false` | Force-disabled |

---

## Blob storage

File uploads on feedback posts need a blob backend. The choice depends on
deploy target:

| Target | What's used | What you set |
|--------|-------------|--------------|
| Cloudflare Workers | R2 bucket via the `BLOB` binding | Bind a bucket in `wrangler.toml` (no env vars) |
| Vercel | Vercel Blob | Connect a Blob store in the dashboard — `BLOB_READ_WRITE_TOKEN` is auto-injected |
| Docker / Node | S3-compatible (`S3_*`) or local-fs fallback | The `S3_*` group below |

### S3-compatible storage &nbsp;⬜ optional (Docker / Node only)

The `modules/blob-s3` Nuxt module registers an S3-compatible blob
provider **at runtime** when the required env vars are set. Works with
AWS S3, Cloudflare R2, MinIO, Alibaba OSS (阿里云 OSS), Tencent COS
(腾讯云 COS), Backblaze B2, Wasabi, Qiniu Kodo (七牛), and any other
service that speaks the S3 API. The official Docker image works as-is —
no rebuild needed.

**Required (always 3):**

- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_BUCKET`

**Plus at least one of** (depends on service):

- `S3_ENDPOINT` — required for non-AWS services (provides the host)
- `S3_REGION` — required for AWS S3; optional elsewhere (signing falls back to `us-east-1`)

When all required vars are absent the app falls back to NuxtHub's
local-filesystem driver, which writes to `/app/.data/blob` inside the
container. The bundled `compose.yml` mounts an `app-data` named volume
on `/app/.data` so local uploads survive container restarts.

#### Service cheat sheet

| Service          | `S3_ENDPOINT`                                   | `S3_REGION`           |
|------------------|-------------------------------------------------|-----------------------|
| AWS S3           | _omit_                                          | `us-east-1` etc.      |
| Cloudflare R2    | `https://<account_id>.r2.cloudflarestorage.com` | _omit (optional)_     |
| MinIO            | `https://minio.yourdomain.com`                  | _omit (optional)_     |
| 阿里云 OSS       | `https://oss-cn-hangzhou.aliyuncs.com`          | `oss-cn-hangzhou`     |
| 腾讯云 COS       | `https://cos.ap-shanghai.myqcloud.com`          | `ap-shanghai`         |
| 七牛 Kodo        | `https://s3-cn-east-1.qiniucs.com`              | `cn-east-1`           |
| Backblaze B2     | `https://s3.us-west-002.backblazeb2.com`        | `us-west-002`         |
| Wasabi           | `https://s3.us-east-1.wasabisys.com`            | `us-east-1`           |

Some providers, including Alibaba OSS, may require virtual-hosted style.
If your provider rejects path-style requests, keep `S3_BUCKET` set and use
the bucket endpoint directly, for example
`https://<bucket>.oss-cn-hangzhou.aliyuncs.com`.

The `modules/blob-s3` module is gated to Node / Docker presets — on
Cloudflare Workers and Vercel builds it is skipped entirely so neither
the s3 driver nor `aws4fetch` ends up in those bundles.

### `UPLOAD_PREFIX` / `NUXT_PUBLIC_UPLOAD_PREFIX` &nbsp;⬜ optional, default `uploads`

Object key prefix under which uploads are stored. Read at runtime.
Useful when sharing a bucket between environments.

```bash
UPLOAD_PREFIX=prod/uploads
NUXT_PUBLIC_UPLOAD_PREFIX=prod/uploads
```

`UPLOAD_PREFIX` is the server-only name used by the upload API.
`NUXT_PUBLIC_UPLOAD_PREFIX` remains supported for deployments that already
use Nuxt public runtime env naming.

---

## AI features

Similar-idea detection and AI-drafted changelog entries both call an
OpenAI-compatible HTTP API. Leave these unset to disable AI features
entirely — the rest of the app works without them.

### `OPENAI_API_KEY` &nbsp;⬜ optional

API key for the LLM provider.

### `OPENAI_BASE_URL` &nbsp;⬜ optional, default `https://api.openai.com/v1`

Base URL of the OpenAI-compatible endpoint. Examples:

- `https://api.openai.com/v1` — OpenAI direct
- `https://<your-resource>.openai.azure.com/openai/deployments/<deployment>` — Azure OpenAI
- `https://<your-litellm-host>/v1` — LiteLLM proxy
- `http://localhost:11434/v1` — Ollama (note: must support 768-dim embeddings)

### `OPENAI_TEXT_MODEL` &nbsp;⬜ optional

Chat model used for AI changelog drafting. Defaults to a current OpenAI
model; set explicitly when targeting Azure deployments or non-OpenAI
providers where the model id differs.

---

## Transactional email

Used for password-reset emails and (optionally) email verification. When
unset, the app falls back to a console provider that just logs the
intended email — fine for development, not for production.

### `EMAIL_PROVIDER` &nbsp;⬜ optional

Provider identifier. Currently supported: `resend`. Leave unset to use
the console-logging fallback.

### `RESEND_API_KEY` &nbsp;⬜ optional

[Resend](https://resend.com) API key. Required when `EMAIL_PROVIDER=resend`.
Setting this also auto-enables sign-up email verification (override with
`AUTH_EMAIL_VERIFY`).

### `EMAIL_FROM` &nbsp;⬜ optional

Sender address for outbound mail (the display name `FeedLog` is added
automatically). Example:

```
EMAIL_FROM=noreply@yourdomain.com
```

The domain must be verified with your email provider.

---

## Platform notes

### Cloudflare Workers

- `DATABASE_URL` is **replaced** by the `POSTGRES` Hyperdrive binding —
  see [`wrangler.toml`](../wrangler.toml) and the [Workers deploy guide](./deploy/cloudflare-workers.md).
- `S3_*` doesn't apply — blob storage uses the `BLOB` R2 binding.
- Public values (`BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID`)
  go in `[vars]` of `wrangler.toml`.
- Secrets (`BETTER_AUTH_SECRET`, `SYSTEM_ADMIN_EMAILS`,
  `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `OPENAI_API_KEY`,
  `RESEND_API_KEY`) are set via `wrangler secret put <NAME>` and are
  never committed to the repo.

### Vercel

- All env vars set via the dashboard or `vercel env add`.
- Make sure `DATABASE_URL` is enabled for both **Production** and
  **Preview** scopes, otherwise the build container can't run migrations.
- Vercel Blob auto-injects `BLOB_READ_WRITE_TOKEN`; no manual config.

### Docker / bare Node

- All env vars set via `-e` on `docker run`, `environment:` in
  docker-compose, or your orchestrator's secret store. All values are
  read at runtime — no rebuild needed when rotating credentials.
- The bundled `compose.yml` mounts an `app-data` named volume on
  `/app/.data` so the local-filesystem fallback survives restarts.
