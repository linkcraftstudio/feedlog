# Changelog

All notable changes to FeedLog will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until FeedLog reaches `1.0.0`, minor versions (`0.x.0`) may contain breaking
changes; patch versions (`0.x.y`) will not.

## [Unreleased]

### Changed

- Node.js 24 is now required, and the Docker image is based on `node:24-slim`.
- Upgrade to Nuxt 4.5 (Vite 8 with Rolldown). The Docker build needs about half
  the time and fits in 3 GB of memory.

## [0.1.0] - 2026-04-27

Initial public release.

### Added

- Feedback boards with voting, comments, and Markdown discussions.
- Public roadmap with drag-and-drop reordering.
- Changelog publishing with AI-drafted style presets.
- Similar-idea detection via OpenAI embeddings; admin merge / unmerge.
- better-auth: email/password, Google OAuth, GitHub OAuth, admin role.
- Three deploy targets: Cloudflare Workers, Vercel, Docker (multi-arch).

[Unreleased]: https://github.com/linkcraftstudio/feedlog/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/linkcraftstudio/feedlog/releases/tag/v0.1.0
