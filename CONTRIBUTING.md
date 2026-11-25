# Contributing to FeedLog

Thanks for wanting to contribute! This guide covers the practical steps:
running the project locally, the kind of changes we're looking for, and how
to send a pull request.

## Ways to contribute

- **Bug reports** — the more reproducible, the better. [Open an issue](../../issues/new?template=bug_report.md).
- **Feature proposals** — discuss first in [Discussions](../../discussions) before writing code. Large changes without prior discussion may be redirected.
- **Documentation** — fixes to `README.md`, deploy guides in `docs/deploy/`, and inline code comments are always welcome.
- **Code** — bug fixes, new features (after discussion), tests, refactors.

## Local development

### Prerequisites

- **Node.js 24+**
- **pnpm 10+** (managed via `packageManager` field in `package.json` — enable with `corepack enable`)
- **PostgreSQL 17+** with the `vector` extension. For local dev, the easiest path is the `pgvector/pgvector` Docker image:

  ```bash
  docker run -d --name feedlog-pg \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=feedlog \
    -p 5432:5432 \
    pgvector/pgvector:pg17
  ```

### Setup

```bash
# Clone
git clone https://github.com/linkcraftstudio/feedlog.git
cd feedlog

# Install deps (postinstall runs `nuxt prepare`)
pnpm install

# Copy the env template and fill in at least DATABASE_URL and BETTER_AUTH_SECRET
cp .env.example .env

# Run migrations
pnpm migrate

# Start the dev server
pnpm dev        # http://localhost:3000
```

### Common commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start Nuxt dev server with HMR |
| `pnpm build` | Production build for Node server preset |
| `pnpm preview` | Preview the production build locally |
| `pnpm generate:migration` | Generate a Drizzle migration after schema changes |
| `pnpm migrate` | Apply pending migrations |
| `pnpm build:cf` | Production build for Cloudflare Workers preset |
| `pnpm deploy:cf` | Deploy the CF build via wrangler |

### Project layout

- `app/` — frontend: pages, components, composables, Pinia stores
- `server/` — backend: API routes, database, server utils, plugins
- `server/db/schemas/` — Drizzle schema (entry point: `index.ts`)
- `server/db/migrations/` — SQL migrations (generated, do not edit by hand)
- `shared/` — code importable from both frontend and backend (types, Zod schemas)
- `docs/deploy/` — self-hosting guides for the three supported platforms

## Making changes

### Before you start

For anything non-trivial, please open a [Discussion](../../discussions) or a
draft issue first. This avoids the awkward case where a PR gets closed
because the approach doesn't fit the project's direction.

### Guidelines

- **Language in code**: all identifiers, comments, commit messages, and
  user-facing strings are in English.
- **TypeScript**: strict typing. Prefer inferred types at usage sites and
  explicit types at module boundaries.
- **UI components**: shadcn-vue is installed via CLI, not manually:
  `pnpm dlx shadcn-vue@latest add <component>`.
- **Database changes**: run `pnpm generate:migration` after schema edits;
  commit both the schema change and the generated SQL.
- **No unexplained internal references**: never commit URLs, email addresses,
  or organization names that belong to an internal deployment.

### Schema & API docs

If you change `server/db/schemas/` or `server/api/` in a way that affects the
public shape of the app, please update the relevant `docs/` entry in the
same PR.

## Sending a pull request

1. Fork the repo and create a topic branch: `git checkout -b fix/short-description`
2. Make your changes. Keep the scope focused — one PR per concern.
3. **Sign off your commits with DCO**: `git commit -s -m "..."`
   The `-s` appends a `Signed-off-by:` trailer, which confirms you agree to
   the [Developer Certificate of Origin](https://developercertificate.org/).
   No CLA required.
4. Push your branch and [open a PR](../../compare) against `main`.
5. Fill in the PR template. Link the issue or discussion that motivated the
   change.
6. CI runs on every PR (build and Docker validation). Please ensure it
   passes before asking for review.

### Commit message style

Short imperative subject line, optional detailed body:

```
fix(admin): prevent duplicate board slugs on rename

The slug generator was running before the conflict check, so two admins
renaming to the same target within a few seconds would both succeed and
collide on next read. Reorder to validate after generation.
```

Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
`test:`) are preferred but not required.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Reporting security issues

**Please do not open a public issue for security vulnerabilities.** Follow
the process in [`SECURITY.md`](./SECURITY.md) instead.

## License

By contributing to FeedLog, you agree that your contributions will be
licensed under the [MIT License](./LICENSE).
