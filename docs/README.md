# FeedLog Documentation

This directory collects the operational docs for self-hosting FeedLog.

## Deployment

Choose the guide that matches where you want to run FeedLog:

| Target | Best for | Guide |
|--------|----------|-------|
| Cloudflare Workers | Serverless edge deploy with Hyperdrive and R2 | [Cloudflare Workers](./deploy/cloudflare-workers.md) |
| Vercel | Managed Node.js deployment with Vercel Blob | [Vercel](./deploy/vercel.md) |
| Docker | Full self-hosting on a VPS, NAS, or Docker PaaS | [Docker](./deploy/docker.md) |

## Configuration

**Three required variables** (`DATABASE_URL`, `BETTER_AUTH_SECRET`,
`SYSTEM_ADMIN_EMAILS`) are enough to boot a working install. Everything
else — OAuth, AI, file uploads, email — is optional.

- **[Configuration reference](./configuration.md)** — every environment variable, grouped by purpose, with defaults and gotchas.
- [`.env.example`](../.env.example) — the same list as an annotated `.env` template you can copy and edit.

## Automation

- **[Agent tokens](./agent-tokens.md)** — long-lived credentials that let a script, bot or AI agent work the board over plain HTTP, with no browser and no human re-authenticating.

## Community

- [README](../README.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
