# Stage 1: Install dependencies (runs on BUILDPLATFORM for native speed).
# pnpm.supportedArchitectures in package.json ensures all target-arch optional
# binaries (e.g. sharp for linux-x64 + linux-arm64) are fetched in this single
# install, so the .output produced in stage 2 is arch-portable.
FROM --platform=$BUILDPLATFORM node:24-slim AS deps

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Stage 2: Build (runs on BUILDPLATFORM for native speed; produces a
# multi-arch-portable .output because deps already contain all target archs).
FROM --platform=$BUILDPLATFORM node:24-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Blob storage is selected at runtime by modules/blob-s3 from S3_* env
# vars. No build-time injection required — the official image works with
# any S3-compatible service via plain `docker run -e S3_*=...`.

ENV NITRO_PRESET=node-server

# Peak V8 heap use is about 1.5 GiB, reached while Nitro bundles the server.
ENV NODE_OPTIONS=--max-old-space-size=2048

# Rolldown's mimalloc otherwise keeps memory it has freed, which adds about
# 750 MiB to the peak. These apply to this stage only, not to the runner.
ENV MIMALLOC_PURGE_DELAY=0
ENV MIMALLOC_ARENA_EAGER_COMMIT=0

RUN pnpm build

# Stage 3: Production
FROM node:24-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/.output ./.output

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
ENV MIGRATIONS_DIR=/app/.output/server/db/migrations

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
