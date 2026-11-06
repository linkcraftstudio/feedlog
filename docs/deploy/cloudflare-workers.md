# Deploying FeedLog to Cloudflare Workers

Cloudflare Workers gives FeedLog a serverless edge deployment — zero idle
cost, global distribution, native integration with R2 for blob storage and
Hyperdrive for accelerated Postgres connections.

## What you need

- A **Cloudflare account** (free tier works for early usage)
- A **Postgres 17+** with the `vector` extension reachable over the public
  internet. Recommended providers: [Neon](https://neon.tech),
  [Supabase](https://supabase.com), [AWS RDS](https://aws.amazon.com/rds/), any
  host you can connect to via TLS.
- **Node.js 22+ and pnpm 10+** on your local machine for manual setup
- **wrangler CLI** for manual setup: `pnpm dlx wrangler --version`
  (installed on demand)

## One-click deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/linkcraftstudio/feedlog)

The button forks this repo into your GitHub account, then prompts you to
configure the bindings and secrets FeedLog needs before it can boot:

- **`POSTGRES` (Hyperdrive)** — click _Create_ and paste your Postgres
  connection string. Hyperdrive pools and accelerates the connection from
  Cloudflare's edge. Your Postgres must have the `vector` extension
  enabled (Neon and Supabase support it out of the box).
- **`BLOB` (R2 bucket)** — click _Create_ and pick a bucket name (e.g.
  `feedlog`) to store uploaded images. You can also skip this step; the
  app still runs, but file uploads will fail until you add the binding
  later from the Cloudflare dashboard.
- **`BETTER_AUTH_SECRET`** — 32+ random chars. Generate with
  `openssl rand -hex 32`.
- **`SYSTEM_ADMIN_EMAILS`** — your email, so the first user you sign up
  with becomes admin. Comma-separate multiple admin bootstrap emails.
  Must be set before the first sign-up; otherwise the install has no
  admin user.

Cloudflare renders `BETTER_AUTH_SECRET` and `SYSTEM_ADMIN_EMAILS` from
`.dev.vars.example` as masked secret fields, uploads them as encrypted
Worker Secrets, and does not write them back to the forked repository.
After the first build, visit the `*.workers.dev` URL Cloudflare prints.

On first request, FeedLog detects the empty database and serves a `/setup`
page that runs migrations in the background. The page redirects back to
the app as soon as the schema is initialized — no local `pnpm migrate`
step required. Sign up with an email listed in `SYSTEM_ADMIN_EMAILS` and
you land as admin.

> The runtime `/setup` page requires the `vector` extension to already
> exist in your Postgres database. Neon and Supabase enable it via their
> UI; for other hosts run `CREATE EXTENSION IF NOT EXISTS vector;` once
> before the first request.

## Manual setup (recommended for production)

### 1. Clone and install

```bash
git clone https://github.com/linkcraftstudio/feedlog.git
cd feedlog
pnpm install
```

### 2. Create the Hyperdrive binding (Postgres acceleration)

Hyperdrive pools and caches connections to your Postgres over Cloudflare's
network, which is essential for Workers (which can't hold long-lived TCP
connections).

```bash
wrangler hyperdrive create feedlog \
  --connection-string="postgresql://USER:PASSWORD@HOST:5432/DATABASE"
```

Copy the returned `id` value and paste it into `wrangler.toml`:

```toml
[[hyperdrive]]
binding = "POSTGRES"
id = "PASTE-THE-ID-HERE"   # <-- replace
```

### 3. Create the R2 bucket (blob storage)

```bash
wrangler r2 bucket create feedlog
```

`wrangler.toml` already declares the binding as `bucket_name = "feedlog"`.
If you use a different name, update the file accordingly.

### 4. Enable the pgvector extension

Migrations run automatically on first request via the `/setup` page, but
they assume the `vector` extension already exists. Enable it once against
your Postgres:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Neon and Supabase expose a UI toggle for this — no SQL needed.

### 5. Configure public (non-secret) env vars in `wrangler.toml`

```toml
[vars]
BETTER_AUTH_URL = "https://feedlog.your-subdomain.workers.dev"
# Optional:
# GOOGLE_CLIENT_ID = "your-oauth-client-id.apps.googleusercontent.com"
```

### 6. Set secrets via `wrangler secret put`

Never put secrets in `wrangler.toml` — use Cloudflare's encrypted secret
store:

```bash
wrangler secret put BETTER_AUTH_SECRET
# Paste a 32+ char random string. Generate one with:
#   openssl rand -hex 32

wrangler secret put SYSTEM_ADMIN_EMAILS
# Your email (comma-separated list if multiple). The first user who signs
# up with one of these emails is promoted to admin automatically.

# Optional — enable Google OAuth
wrangler secret put GOOGLE_CLIENT_SECRET

# Optional — enable AI features
wrangler secret put OPENAI_API_KEY

# Optional — transactional email
wrangler secret put RESEND_API_KEY
```

### 7. Build and deploy

```bash
pnpm build:cf       # Nuxt build with NITRO_PRESET=cloudflare-module
pnpm deploy:cf      # wrangler deploy --cwd .output
```

Your app is now live at the URL wrangler prints (e.g.
`https://feedlog.your-subdomain.workers.dev`).

### 8. Configure a custom domain (optional)

In the Cloudflare dashboard → Workers & Pages → your worker → Custom Domains.
Point a route like `feedback.yourdomain.com` at the worker. Update
`BETTER_AUTH_URL` in `wrangler.toml` to match, and redeploy.

## Environment variable reference

Values that end up in the running Worker come from three places:

1. **`[vars]` in `wrangler.toml`** — public config (base URL, OAuth client IDs). Committed.
2. **`wrangler secret put`** — sensitive values (auth secret, OAuth client secrets, API keys). Never committed.
3. **Bindings** — the Hyperdrive `POSTGRES` binding replaces `DATABASE_URL`, and the R2 `BLOB` binding replaces S3-compatible blob storage.

So for Cloudflare deployments you **don't set** `DATABASE_URL` or any
`S3_*` variables — the bindings do that work. All other env vars from
[`.env.example`](../../.env.example) apply as usual.

For the complete list of environment variables FeedLog reads, see the
**[configuration reference](../configuration.md)**.

## Updating

```bash
git pull                       # pull the latest FeedLog changes
pnpm install                   # refresh dependencies
pnpm build:cf && pnpm deploy:cf
```

If the release includes new migrations, sign in with an email listed in
`SYSTEM_ADMIN_EMAILS` on the deployed site and visit `/setup` — the page runs the pending upgrade and redirects
back. Anonymous upgrades are refused (that would let any visitor trigger
a schema change).

## Common issues

### `Error 1101: Worker threw exception` on first request

Almost always a Hyperdrive connection failure. Check:
- The Postgres reachable from Cloudflare's network (public IP + TLS)
- The connection string in `wrangler hyperdrive create` included the correct
  database name and credentials
- The `vector` extension is installed

Use `wrangler tail` to see the real error:

```bash
wrangler tail
```

### OAuth callback gives "redirect_uri_mismatch"

The registered callback URL in Google / GitHub OAuth must match
`${BETTER_AUTH_URL}/api/auth/callback/<provider>` exactly, including the
scheme and any custom domain.

### `/setup` page loops or reports `unreachable`

Hit `/api/_migrate/status` directly and check the `state` field:

- `unreachable` — the Hyperdrive binding isn't resolving. Verify the
  `POSTGRES` binding id in `wrangler.toml` matches a real Hyperdrive
  config (`wrangler hyperdrive list`), and that its connection string
  works from outside Cloudflare.
- `bootstrap` after clicking "Try again" — most commonly a missing
  `vector` extension. Run `CREATE EXTENSION IF NOT EXISTS vector;` and
  retry.
- `pending` but the page refuses to advance — the upgrade path requires a
  signed-in admin. Sign in through `/api/auth/...` first, then refresh
  `/setup`.

### First-install sign-in

The `/setup` page completes DB initialization but does not create a user.
To get admin access on a fresh install:

1. Go to the app home, sign up via email + password using an address listed
   in `SYSTEM_ADMIN_EMAILS`.
2. better-auth's admin plugin promotes that user to `role = 'admin'` on
   first sign-up.
3. Configure GitHub or Google OAuth later from the dashboard if desired
   (OAuth providers need your public URL as a callback; easier to wire
   once the Worker has a stable URL).

## Next steps

- **[Docker deploy](./docker.md)** — single-container self-hosting
- **[Vercel deploy](./vercel.md)** — managed Node.js deploy
