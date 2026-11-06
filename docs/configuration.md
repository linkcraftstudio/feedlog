# Configuration reference

MCP is enabled by default; set `MCP_ENABLED=false` to disable it. The server uses the current external origin unless `BETTER_AUTH_URL` is configured. See [MCP](./mcp.md) for connection, organization access, and migration instructions.

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

The Widget Agent, similar-idea detection, and AI-drafted changelog entries call an
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

Model used for Widget Agent conversations and AI changelog drafting.
The Widget Agent requires an explicit model name and API key; without either,
messages are saved for human support when the organization has support staff. The Widget transfers silently, without an AI reply or status notice. If no staff can receive the conversation, the message stays saved and the Widget remains silent, without claiming a transfer. Choose an OpenAI-compatible chat model
with tool calling and, for image attachments, image input support.

Each customer message accepts up to ten images; text does not count toward this limit.
The Widget rejects selections exceeding the limit before uploading, and the message API
enforces the same image count.

Images are processed before upload and Send stays disabled until uploads finish. Native
browser WebP encoding starts at quality 0.85, targeting 1 MiB with a 2 MiB hard limit.
Compatible small images remain unchanged. Ordinary images retain their full frame and
fit a 2048-pixel longest edge. Images with aspect ratio above 3 retain up to 4096 pixels
and do not undergo further dimension reduction; this does not guarantee tiny text is readable.
SVG rasterization and lazy HEIC conversion remain supported. Original inputs may be up to
32 MiB. New messages accept ten images totaling at most 10 MiB, validated server-side from
stored metadata. Historical attachments retain the former 16 MiB / 4096-pixel compatibility.

A batch now defaults to ten images / 16 MiB of compressed file bytes (approximately
21.4 MiB as base64). Thus ten compressed images within the new message budget are analyzed
in one request. Larger historical sets or a stricter provider configuration may split into
batches, with two batch workers per conversation. Set `AGENT_IMAGE_BATCH_MAX_IMAGES`
(1–10, default 10) and `AGENT_IMAGE_BATCH_MAX_MIB` (4–16, default 16) to match the provider.
There is no whole-run concurrency semaphore. Uploads and image reads use the existing
Blob storage API, and image analysis uses the model SDK with a bounded input batch.
The image dependency timeout remains 60 seconds and the fixed first-answer deadline remains
120 seconds. Background activity cannot renew it. After visible text begins, inactivity
controls cancellation. Failed image analysis produces a retryable error, not a handoff.
Every image must return a numbered observation before the final answer is generated.

These are application limits, not automatically discovered model limits; text, response
and visual-token limits still depend on the selected model. Batch observations preserve
image numbers, visible text and uncertainty for comparison but are not lossless substitutes
for the original pixels. Their usage is included in the run's token statistics.
Historical images share the same request budget, with newer images preferred. The server checks actual JPEG/PNG/WebP bytes and dimensions.
Metadata preflight has a shared 15-second budget per message. Image bytes are read
lazily from filesystem, S3, R2 or Vercel storage and incrementally base64-encoded with
backpressure; the server never assembles a complete image/data URL for analysis.
Storage opens and stalled reads have 15-second limits, excluding time spent waiting
for the model transport to accept a chunk. Cancellation closes the underlying reader.
Unknown custom storage drivers fail rather than silently buffering whole objects.
Multipart uploads keep their separate single-allocation permit. Invalid images
can be replaced without transferring the conversation to a person. Legacy images
that cannot be read are excluded from model history without removing their saved attachments.

Inbox access is granted to owners, managers and contributors through the separate
`feedlog:inbox` permission. It does not grant content moderation or organization
administration. Dashboard entry selects an accessible page; restricted navigation
is blocked with the existing permission toast.

Missing AI configuration transfers silently when human support is available; the
internal handoff event and owner notification are retained. AI execution failures
and timeouts instead show the existing error and retry controls, without automatically
transferring. An unavailable handoff is silent, including after history reload,
and does not show a success notice or retry control.

Successful requested handoffs keep the standard confirmation. Enabled support rules
use billing, account-access, privacy, or generic custom-rule confirmation text.
The same localized notice is used during streaming and when reading history.

Each successful handoff queues a durable administrator email after the transaction
commits. Only the organization's owners receive it, with an Inbox link
and no customer message content. Delivery tracks successful recipients and retries
failures up to three attempts. Configure a real email provider for delivery;
`console` does not send notifications. Subsequent human messages retain their existing behavior.

Articles with AI Usage enabled are available to the agent independently of
publication and collection visibility. Customer-facing article references require
a published article in a visible collection and the public Help Center enabled.

The Widget SDK declares host-page context support through `init` with
`capabilities.pageContext: true`. Without this capability, the Widget skips
page-detail collection immediately. The verified parent origin from the init handshake
is still attached when available. Supported hosts have a 500 ms response timeout;
missing page details do not prevent sending a message. Context stores the HTTP(S)
origin and pathname, never query parameters or fragments, so reply emails can link
back to the host product page.

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

- Inbox requires the `feedlog-inbox` Queue: create it with
  `pnpm exec wrangler queues create feedlog-inbox` before deploying. The producer,
  consumer and daily recovery cron are configured in `wrangler.toml`.
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

- Inbox requires Vercel Queues for delayed tasks. The build configures the
  `feedlog-inbox` topic trigger; `vercel.json` schedules daily recovery.
- All env vars set via the dashboard or `vercel env add`.
- Make sure `DATABASE_URL` is enabled for both **Production** and
  **Preview** scopes, otherwise the build container can't run migrations.
- Vercel Blob auto-injects `BLOB_READ_WRITE_TOKEN`; no manual config.

### Docker / bare Node

- Inbox restores persisted task timers on startup and runs recovery every five
  minutes. No external queue service or host crontab is required.
- All env vars set via `-e` on `docker run`, `environment:` in
  docker-compose, or your orchestrator's secret store. All values are
  read at runtime — no rebuild needed when rotating credentials.
- The bundled `compose.yml` mounts an `app-data` named volume on
  `/app/.data` so the local-filesystem fallback survives restarts.

### Agent inactivity timeout

The first visible answer has a fixed 120-second budget. Image batches, reasoning,
tools and heartbeats cannot renew it. Once nonempty answer text arrives, each text
delta renews a 120-second inactivity window. Database recovery follows the same
deadline; continuous answers may exceed 120 seconds in total. The Widget also
starts this two-phase timer at Send, covering preflight/network waiting.
Image analysis requests retain their 60-second limit and share the first-answer
budget. Agent knowledge/feedback reads have a 5-second wait limit; feedback query
embedding has a 5-second transport timeout and help query embedding retains its
stricter 2.5-second timeout. Dependency timeout fails the run rather than silently
handing off. Late read results are ignored; SQL retains its existing statement
limit. Hosting providers and reverse proxies must permit long streams.

Image conversion, compression and upload start on selection, before Send is enabled.
The Widget blocks Send while processing or
while an attachment error remains unresolved. The message endpoint validates stored
attachments before creating a run, then reuses that input instead of rereading the
current attachments during agent preparation. Interrupted text is cleared; the existing error area and Retry reply button are
used. Customer messages and uploaded attachments remain available for retry.
Incremental conversation polling includes the latest run state even when no new message
was appended, so a timeout can unlock retry after the stream has disconnected.


Owner handoff notifications include the customer's name (or Visitor), non-anonymous email,
handoff reason, latest customer message and attachment count. When AI is available, the
notification task may add a 2–3 sentence English summary with a five-second limit.
The email copy and summary use English; the latest customer message retains its original language. AI-unavailable
handoffs skip this call; summary failures fall back to the latest message. The task saves
its notification context before delivery so retries retain the same handoff-time content.


### Malformed handoff output

If a model returns handoff protocol as answer text, the run stops that stream and
rechecks the actual customer messages against enabled support rules using a separate
structured decision. This recovery has a 15-second dependency limit and shares the
original run deadline. Only a validated decision invokes the regular handoff
transaction, which creates the system event and Owner notification task. A declined
or failed decision follows the existing error/retry flow; it does not transfer the
conversation. The Widget clears transient text without adding a new UI element.
Contaminated assistant history and subsequent assistant claims are excluded from
model input, while customer messages and persisted diagnostic evidence are retained.

### Agent phase diagnostics

Set `AGENT_TIMING=true` to log image-analysis start/end, first visible answer, and
run completion/failure. Records include run IDs, image counts/bytes and durations;
they exclude message bodies, images, prompts and credentials. No per-step tracing
context or additional tracing service is installed.

Active runs share one batched status query per second per database pool, avoiding
per-conversation polling amplification. This does not serialize model execution.
