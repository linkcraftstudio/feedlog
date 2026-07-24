<div align="center">

<img src="./public/logo.svg" alt="FeedLog" width="88" />

# FeedLog

**Open-source feedback & roadmap tool. Self-host on Cloudflare Workers, Vercel, or Docker.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Discussions](https://img.shields.io/github/discussions/linkcraftstudio/feedlog)](https://github.com/linkcraftstudio/feedlog/discussions)
[![Stars](https://img.shields.io/github/stars/linkcraftstudio/feedlog?style=social)](https://github.com/linkcraftstudio/feedlog)

[Live Demo](https://feedback.feedlog.ai) · [Documentation](./docs) · [Discussions](https://github.com/linkcraftstudio/feedlog/discussions)

</div>

---

> Collect product feedback, run a public roadmap, and publish changelogs — from a tool you own and control.

FeedLog is a feedback-collection and product-communication hub for software teams. Users post ideas, vote, and discuss; teams triage into a roadmap and publish changelog entries when features ship. Built on Nuxt 4, it deploys to three platforms with zero vendor lock-in.

![FeedLog feedback board](./docs/images/hero.png)

## Why FeedLog?

- 🌐 **Deploy anywhere.** Cloudflare Workers, Vercel, or Docker — pick your stack, keep your data.
- 🤖 **AI-native, not AI-washed.** Similar-idea detection and AI-assisted changelog drafting — first-class features, not bolted-on chatbots.
- 🎨 **Modern Vue stack.** Nuxt 4, TypeScript, Drizzle ORM, Tailwind CSS v4, shadcn-vue.
- 🔓 **MIT licensed, open core.** This repository is the complete current product. Future enterprise add-ons live separately; the open-source version stays fully functional.
- 📦 **Own your data.** Postgres + blob storage (Cloudflare R2, Vercel Blob, or any S3-compatible: AWS, MinIO, Alibaba OSS).

## Live Demo

Try FeedLog running in production: **[feedback.feedlog.ai](https://feedback.feedlog.ai)**

The roadmap, changelog, and feedback boards you see at that URL are all FeedLog itself running in production — every feature listed below was first requested, voted on, and shipped through it.

## Self Hosting

FeedLog is built to be self-hosted. Three deploy targets cover the common
cases: serverless platforms (Cloudflare Workers, Vercel) for zero-ops
managed hosting, and Docker for full control on a VPS / NAS / Docker PaaS.

Whichever path you pick, you'll need a **PostgreSQL 17+** with the
[`vector`](https://github.com/pgvector/pgvector) extension reachable from
the runtime. [Neon](https://neon.tech) and [Supabase](https://supabase.com)
both enable it via their UI; on self-hosted Postgres run
`CREATE EXTENSION IF NOT EXISTS vector;` once.

### `A` Deploy with Cloudflare Workers or Vercel

Both platforms offer a one-click deploy that forks the repo into your
account and prompts for the [required environment variables](#environment-variables)
in the same form. Build and deploy run automatically; no local toolchain
needed.

<div align="center">

|             Deploy to Cloudflare Workers              |                                                                                                                                                                                                                                                                                          Deploy with Vercel                                                                                                                                                                                                                                                                                          |
| :---------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| [![][cf-deploy-img]][cf-deploy-link]                  | [![][vercel-deploy-img]][vercel-deploy-link]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

</div>

- **Cloudflare Workers** uses Hyperdrive (Postgres acceleration) and R2
  (blob storage). On first request, the deployed Worker serves a `/setup`
  page that runs migrations against your Hyperdrive-bound database. Full
  guide: [`docs/deploy/cloudflare-workers.md`](./docs/deploy/cloudflare-workers.md).
- **Vercel** runs `pnpm migrate && pnpm build` in the build step; failed
  migrations abort the deploy and leave the previous version serving
  traffic. Pair with Neon or Supabase from the Vercel Marketplace for the
  fastest setup. Full guide: [`docs/deploy/vercel.md`](./docs/deploy/vercel.md).

#### Keep your fork up to date

Both platforms deploy from a fork of this repo, so to pick up upstream
fixes you'll want either a manual `git pull` from `linkcraftstudio/feedlog`,
or a scheduled GitHub Action (e.g. [`tgymnich/fork-sync`](https://github.com/tgymnich/fork-sync))
that opens a PR against your fork's `main` whenever upstream changes.

### `B` Deploy with Docker

Multi-arch image (`linux/amd64` + `linux/arm64`) on
`ghcr.io/linkcraftstudio/feedlog`. Works on any Linux host — VPS, NAS,
Coolify, Dokploy, Portainer, Kubernetes.

#### Quick start with the bundled `compose.yml`

The repo ships a [`compose.yml`](./compose.yml) that brings up the app
and a `pgvector`-enabled Postgres in one command. Three lines:

```bash
git clone https://github.com/linkcraftstudio/feedlog.git && cd feedlog
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" > .env
echo "SYSTEM_ADMIN_EMAILS=you@example.com" >> .env
docker compose up -d
```

The app is at `http://localhost:3000`. Sign up with an email listed in
`SYSTEM_ADMIN_EMAILS` to land as admin. Optional variables (OAuth, AI,
transactional email) can be added to the same `.env` — `compose.yml`
passes them through to the app container.

#### Single-container run

If you bring your own Postgres (with `pgvector`):

```bash
docker run -d --name feedlog -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/feedlog" \
  -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e SYSTEM_ADMIN_EMAILS="you@example.com" \
  ghcr.io/linkcraftstudio/feedlog:v0.1.0
```

The default image falls back to NuxtHub's local-filesystem driver for
uploads — fine for a trial; mount a volume on `/app/.data` to make
those uploads survive container restarts. For S3-compatible storage
(AWS S3 / R2 / MinIO / Alibaba OSS / etc.), set the `S3_*` env vars at
runtime — no rebuild needed. See [`docs/deploy/docker.md`](./docs/deploy/docker.md).

> [!TIP]
> Both quick starts pin to `:v0.1.0`. In production prefer an immutable
> tag (`:vX.Y.Z` or `:sha-abc1234`) over `:latest` to avoid surprise
> upgrades on `docker pull`.

### Environment variables

The three variables in the **Required** table are the minimum to boot a
working install. The most useful optional variables are listed below; the
[**full configuration reference**](./docs/configuration.md) (and
[`.env.example`](./.env.example) as the annotated source) covers
everything else — S3 storage, transactional email, platform-specific
overrides, and authentication toggles.

#### Required

| Variable              | Required | Description                                                                                                                                                       | Example                                                |
| --------------------- | :------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `DATABASE_URL`        |   Yes    | PostgreSQL 17+ connection string. The database must have the `vector` extension installed. On Cloudflare Workers, this is **replaced** by the Hyperdrive binding. | `postgresql://user:pass@host:5432/feedlog?sslmode=require` |
| `BETTER_AUTH_SECRET`  |   Yes    | Session and cookie encryption secret, 32+ random characters. Generate with `openssl rand -hex 32`. Rotating it invalidates every existing session.                | `0a1b2c3d4e5f...` (64 hex chars)                         |
| `SYSTEM_ADMIN_EMAILS` |   Yes    | Comma-separated emails granted admin role on **first sign-up**. Set this before any user signs up — otherwise the install has no admin and the dashboard is locked. | `you@example.com,ops@example.com`                        |

#### Common optional

| Variable                                      | Required | Description                                                                                                                                  | Example                                |
| --------------------------------------------- | :------: | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `BETTER_AUTH_URL`                             |    No    | Public URL of the app (no trailing slash). Inferred from the request `Host` header by default. Set explicitly behind Host-rewriting proxies or to anchor OAuth callback URLs. | `https://feedback.yourdomain.com`      |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`   |    No    | Enable Google OAuth. Authorized redirect URI: `<BETTER_AUTH_URL>/api/auth/callback/google`.                                                  | `…apps.googleusercontent.com`          |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`   |    No    | Enable GitHub OAuth. Callback URL: `<BETTER_AUTH_URL>/api/auth/callback/github`.                                                             | `Iv1.abc123…`                          |
| `OPENAI_API_KEY`                              |    No    | Enable AI features (similar-idea detection, AI-drafted changelog entries). Without it, those features are silently disabled.                 | `sk-…`                                 |
| `OPENAI_BASE_URL`                             |    No    | Override the OpenAI endpoint — works with Azure OpenAI, LiteLLM, self-hosted gateways. Defaults to `https://api.openai.com/v1`.              | `https://your-litellm-host/v1`         |
| `RESEND_API_KEY`                              |    No    | Enable transactional email via [Resend](https://resend.com) (password resets, optional sign-up verification). Without it, emails are logged to stdout. | `re_…`                                 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` (+ `S3_ENDPOINT` / `S3_REGION`) | No | Enable S3-compatible blob storage at runtime — works with AWS S3, Cloudflare R2, MinIO, Alibaba OSS, Tencent COS, etc. Without these, uploads use NuxtHub's local-filesystem driver. See the [service cheat sheet](./docs/configuration.md#s3-compatible-storage). | `LTAI5t…` / `…` / `feedlog-prod` (+ endpoint/region) |

[cf-deploy-img]: https://deploy.workers.cloudflare.com/button
[cf-deploy-link]: https://deploy.workers.cloudflare.com/?url=https://github.com/linkcraftstudio/feedlog
[vercel-deploy-img]: https://vercel.com/button
[vercel-deploy-link]: https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flinkcraftstudio%2Ffeedlog&project-name=feedlog&repository-name=feedlog&env=DATABASE_URL,BETTER_AUTH_SECRET,SYSTEM_ADMIN_EMAILS&envDescription=DATABASE_URL%3A%20Postgres%20connection%20string%20with%20pgvector%20enabled%20(Neon%20or%20Supabase%20from%20the%20Vercel%20Marketplace%20works%20out%20of%20the%20box).%20BETTER_AUTH_SECRET%3A%2032%2B%20char%20random%20string%20(run%20%60openssl%20rand%20-hex%2032%60).%20SYSTEM_ADMIN_EMAILS%3A%20your%20email%2C%20granted%20admin%20role%20on%20first%20sign-up.&envLink=https%3A%2F%2Fgithub.com%2Flinkcraftstudio%2Ffeedlog%2Fblob%2Fmain%2Fdocs%2Fdeploy%2Fvercel.md

## Features

- **Feedback boards** — Organize ideas into public or private boards with voting, categories, and status workflows.
- **Roadmap** — Drag-and-drop view of planned, in-progress, and shipped work.
- **Changelog** — Publish release notes with AI-drafted style presets (concise, structured, benefit-led, witty).
- **Similar-idea merge** — Vector embeddings (OpenAI `text-embedding-3-large`, 768-dim) surface duplicate feedback before it fragments the board.
- **Authentication** — Email / password, Google OAuth, GitHub OAuth, admin role handling — powered by [better-auth](https://www.better-auth.com).
- **Comments & discussions** — Markdown-powered threads on every post.
- **Notifications** — Authors and upvoters are subscribed automatically and emailed when a post's status changes or the team replies officially; unsubscribe per post at any time. Admins aren't notified. Requires an email provider.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Framework | Nuxt 4 (Vue 3, Nitro, TypeScript) |
| Database | PostgreSQL 17+ with `pgvector` for embeddings |
| ORM / driver | Drizzle ORM + `postgres-js` |
| Authentication | better-auth (email/password + Google OAuth + GitHub OAuth + admin plugin) |
| AI | OpenAI-compatible API (OpenAI, Azure, LiteLLM, Ollama…) |
| Blob storage | Cloudflare R2 binding, Vercel Blob, or S3-compatible via `aws4fetch` (AWS, MinIO, OSS) |
| State | Pinia |
| UI | Tailwind CSS v4, shadcn-vue (new-york), Lucide icons |
| Editor | md-editor-v3 |
| Deploy targets | Cloudflare Workers, Vercel, Node.js Docker |
| Package manager | pnpm |

## Local Development

```bash
git clone https://github.com/linkcraftstudio/feedlog.git
cd feedlog
pnpm install
cp .env.example .env   # fill in DATABASE_URL, BETTER_AUTH_SECRET, SYSTEM_ADMIN_EMAILS
pnpm migrate           # initialize database schema
pnpm dev               # http://localhost:3000
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full development setup
and PR process.

## Roadmap

Live, user-voted roadmap: **[feedback.feedlog.ai/roadmap](https://feedback.feedlog.ai/roadmap)**.

Release history: see [`CHANGELOG.md`](./CHANGELOG.md).

## Contributing

Pull requests, bug reports, and feature discussions are welcome.

- Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for development setup and the PR process.
- All commits are signed off under the [DCO](https://developercertificate.org/) (`git commit -s`).
- See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? Please email **feedlog.oss@outlook.com** rather than filing a public issue. See [`SECURITY.md`](./SECURITY.md) for details and response timelines.

## Community

- **[GitHub Discussions](https://github.com/linkcraftstudio/feedlog/discussions)** — questions, ideas, show-and-tell
- **[Issue tracker](https://github.com/linkcraftstudio/feedlog/issues)** — bugs and feature requests

## License

[MIT](./LICENSE) © 2026 LinkCraft Studio
