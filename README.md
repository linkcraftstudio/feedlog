<div align="center">

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/banner.png" alt="FeedLog — The Open-Source AI Customer Support Platform" width="100%" />

# FeedLog

**The Open-Source AI Customer Support Platform.**

AI-driven customer support with a Widget, a self-improving knowledge base, and a feedback board — cut manual support time by 90% and save your support team significant time and effort. Open source. Self-hostable.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Discussions](https://img.shields.io/github/discussions/linkcraftstudio/feedlog)](https://github.com/linkcraftstudio/feedlog/discussions)
[![Stars](https://img.shields.io/github/stars/linkcraftstudio/feedlog?style=social)](https://github.com/linkcraftstudio/feedlog)
[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/9rj64WXESn)
[![X](https://img.shields.io/badge/X-@feedlog__ai-000000?logo=x&logoColor=white)](https://x.com/feedlog_ai)

English | [简体中文](./README.zh-CN.md)

🌟 [Website](https://feedlog.ai) | [Documentation](https://help.feedlog.ai/) | [Live Demo](https://feedback.feedlog.ai/) | [Discussions](https://github.com/linkcraftstudio/feedlog/discussions)

</div>

---

## The Pain Points

- **Support demand grows unnoticed.** Early-stage teams answer users themselves, until repetitive inquiries create rising costs and operational drag.
- **Product knowledge falls out of sync.** Product changes can leave documentation and AI responses outdated.
- **Core teams lose focus.** Product and engineering are repeatedly pulled into support, slowing delivery.
- **Human handoffs break continuity.** Without full context, customers have to repeat themselves and resolution slows down.
- **Customer feedback lacks structure.** Scattered requests and bugs make patterns, priorities, and support impact difficult to see.

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/pain-points.png" alt="From an orderly inbox to lost feedback" width="100%" />

## Our Vision

**You may not think you need customer support yet. But if a founder, product manager, or engineer is answering user questions, you already have it.**

FeedLog helps you keep the value of customer support without turning it into a full-time cost: AI answers recurring questions from your product knowledge, while people step in only when human judgment is needed.

Every SaaS team should be able to listen to and help its customers without letting support consume its time or budget. FeedLog's Widget and Inbox help teams hear users and answer their questions; Feedback and Roadmap connect those voices to product plans; and Changelog brings shipped improvements back to the customers who asked for them. Customer support keeps creating value without becoming a burden.

## See FeedLog in Action

<https://github.com/user-attachments/assets/3e5e5f6d-eb07-4139-823f-564b1fd4f462>

## Why Choose FeedLog?

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/product-loop.png" alt="FeedLog three-step loop from support to product feedback" width="100%" />

*FeedLog connects customer support and product work in one continuous loop.*

### Key Features

#### 1. Widget for AI Support, Help, and Feedback

Give customers AI support and feedback in one place — reducing repetitive work and capturing clearer product signals.

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/feature-widget.gif" alt="FeedLog Widget inside a product" width="100%" />

#### 2. A Unified Inbox for AI–Human Support

Bring AI and human support into one inbox, so your team can take over complex cases with full context and resolve them faster.

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/feature-inbox.gif" alt="FeedLog Inbox" width="100%" />

#### 3. A Knowledge-Grounded AI Agent That Improves Over Time

Give your AI Agent the latest product knowledge and context to answer repetitive questions reliably — reducing manual support work and improving with every conversation.

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/feature-help-center.gif" alt="FeedLog Help Center used by the Agent" width="100%" />

#### 4. A Connected Feedback-to-Changelog Workflow

Turn conversations into clear priorities — so teams know what to build and customers see their feedback shipped.

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/feature-feedback-roadmap-changelog.gif" alt="FeedLog feedback boards, roadmap and changelog" width="100%" />

### Live Demo

**See FeedLog in action: [feedback.feedlog.ai](https://feedback.feedlog.ai)**

We use FeedLog to support our users, collect feedback, and manage our product roadmap.

Explore how AI-powered customer support helps SaaS teams answer questions faster, reduce manual work, and turn customer feedback into product improvements.

### Built for SaaS teams that:

- answer the same customer questions repeatedly;
- need a clear path from AI support to human support;
- want customer conversations to inform product decisions.

## Quick Start

Get FeedLog running in three stages:

1. Start FeedLog.
2. Prepare your AI support.
3. Add the Widget to your product and test it.

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/quick-start-steps.png" alt="FeedLog three-step quick start" width="100%" />

If you are not sure which deployment option to choose, start with Hosted.

### 1. Start FeedLog

#### Hosted

The easiest way to get started. FeedLog runs the service for you, so you do not need to prepare a server or database.

**[Create a FeedLog workspace →](https://auth.feedlog.ai/)**

#### Self-Hosted

Choose Self-Hosted if you want to run FeedLog on your own infrastructure. FeedLog requires PostgreSQL 17+ with the [`vector`](https://github.com/pgvector/pgvector) extension.

<details open>
<summary><b>Deploy on a cloud platform</b></summary>

Both platforms fork the repo into your account and prompt for the required environment variables. Build and deploy run automatically.

| Deploy to Cloudflare Workers | Deploy with Vercel |
| :---: | :---: |
| [![][cf-deploy-img]][cf-deploy-link] | [![][vercel-deploy-img]][vercel-deploy-link] |

See the [Cloudflare Workers guide](./docs/deploy/cloudflare-workers.md) and the [Vercel guide](./docs/deploy/vercel.md).

</details>

<details open>
<summary><b>Deploy with Docker</b></summary>

```bash
git clone https://github.com/linkcraftstudio/feedlog.git
cd feedlog
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" > .env
echo "SYSTEM_ADMIN_EMAILS=you@example.com" >> .env
docker compose up -d
```

FeedLog will be available at `http://localhost:3000`. See the [Docker guide](./docs/deploy/docker.md).

</details>

> [!IMPORTANT]
> Set `SYSTEM_ADMIN_EMAILS` before you create your account. An email listed there becomes the workspace owner when it signs up; accounts created before their email was listed are not promoted later. Without an owner, nobody can manage the dashboard. See the [configuration reference](./docs/configuration.md) for all environment variables.

Self-hosted installations also require a configured model service for AI features. See the [Self-Hosting Guide](https://help.feedlog.ai/self-hosting/overview) for deployment options and configuration details.

### 2. Prepare Your AI Support

#### Add your product knowledge

Open the Help Center in your FeedLog workspace and create articles for:

- Common product workflows
- User permissions and feature limits
- Common problems and troubleshooting
- Situations that require human support

Enable **Allow AI usage** for the articles that FeedLog Agent should use.

Start with the questions your support team receives most often. You do not need to document everything before trying FeedLog.

#### Configure Agent behavior

Before launching Agent:

1. Review your feedback boards and separate bugs, feature requests, and improvements.
2. Open **Settings → Widget**.
3. Add your support email.
4. Set the situations that should receive human support guidance.
5. Decide how customers sign in: allow guest access in **Workspace → Guest permissions**, or connect your existing product accounts with SSO.

FeedLog Agent uses the same Widget integration. No separate Agent installation is required.

See the [Agent Setup Guide](https://help.feedlog.ai/agent/setup).

### 3. Add the Widget to Your Product

Install the Widget package:

```bash
npm install @feedlog/widget
```

Initialize it in your application:

```ts
import { createWidget } from '@feedlog/widget'

createWidget({
  baseUrl: 'https://your-workspace.feedlog.ai',
  theme: 'auto',
})
```

Copy your workspace URL from **Settings → Widget** and set it as `baseUrl`. If your product already has user accounts, see the [Widget and SSO Guide](https://help.feedlog.ai/developers/widget).

#### Test before launch

Open the Widget on a test page and check:

- Ask a question covered by your Help Center.
- Ask a follow-up question.
- Submit a bug or feature request.
- Ask for human support with an account-related problem.
- Check that the feedback is saved correctly.

Once everything works as expected, make the Widget available to your customers.

## Features

| Feature | Description |
| --- | --- |
| FeedLog Agent | Answers product questions from your Help Center and manages feedback through natural conversations. |
| Product Widget | Lets customers ask questions, read help articles, and submit feedback inside your product. |
| Help Center | Create searchable collections and articles, and choose which content Agent can use as product knowledge. |
| Inbox | Manage Widget conversations, human handoffs, and reply email notifications in one place. |
| Feedback Boards | Organize bug reports, feature requests, and improvements with posts, voting, comments, and status workflows. |
| Similar Feedback Detection | Find related feedback and merge duplicate requests before they become fragmented. |
| Roadmap | Share planned, in-progress, and completed work through a public roadmap. |
| Changelog | Publish product updates and draft release notes with AI from your update notes and related feedback. |
| Human Support Guidance | Configure support emails and rules for billing, account, privacy, and other requests that require human help. |
| Authentication and SSO | Support email/password, Google, GitHub, guest access, and existing product accounts. |

## Getting Started & Staying Tuned

⭐ Star FeedLog on GitHub and stay up to date with our latest releases and improvements!

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/star-guide.gif" alt="Star FeedLog on GitHub" width="100%" />

## Tech Stack

| Layer | Choice |
| --- | --- |
| Framework | Nuxt 4 with Vue 3, Nitro, and TypeScript |
| Database | PostgreSQL 17+ with `pgvector` for embeddings |
| ORM / Driver | Drizzle ORM with `postgres-js` |
| Authentication | better-auth with email/password, Google OAuth, GitHub OAuth, and admin roles |
| AI | OpenAI-compatible API, including OpenAI, Azure OpenAI, LiteLLM, and Ollama |
| Blob Storage | Cloudflare R2, Vercel Blob, or any S3-compatible storage |
| State Management | Pinia |
| UI | Tailwind CSS v4, shadcn-vue, and Lucide Icons |
| Editor | Tiptap 3 and CodeMirror 6 |
| Deploy Targets | Cloudflare Workers, Vercel, and Node.js Docker |
| Package Manager | pnpm |

## AI Integrations

FeedLog works with AI applications and coding agents through MCP and Skills.

- **FeedLog MCP** — Connect Claude, ChatGPT, Claude Code, Codex, Cursor, and other MCP-compatible clients to authorized FeedLog organizations. Query and manage feedback, boards, duplicate requests, Help Center articles, and changelogs through natural language.
- **FeedLog Skills** — Give coding agents FeedLog product knowledge, integration instructions, and task guidance. Use Skills to integrate the Widget and SSO, draft Help Center articles from your codebase, and handle routine FeedLog tasks.

Install FeedLog Skills in your project:

```bash
npx skills add linkcraftstudio/feedlog-skills
```

MCP provides access to your FeedLog organization data. Skills help coding agents understand FeedLog and work with your project code. They can be used together or separately.

Learn more in the [MCP and Skills Guide](https://help.feedlog.ai/mcp).

## Roadmap

FeedLog is built in public and shaped by the teams using it. Our roadmap focuses on making customer support more useful for SaaS teams and making the connection between support, feedback, and product development easier to manage.

<img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/roadmap-board.png" alt="FeedLog product roadmap board" width="100%" />

Follow the [public roadmap](https://feedback.feedlog.ai/roadmap) to see what is planned, in progress, and completed.

## Contributing

Pull requests for code, documentation, and tests are welcome. To report a bug, suggest an improvement, or ask where to start, use the channels in [Community & Contact](#community--contact).

### Local Development

You need Node.js, pnpm, and a PostgreSQL 17+ database with the [`vector`](https://github.com/pgvector/pgvector) extension.

```bash
git clone https://github.com/linkcraftstudio/feedlog.git
cd feedlog
pnpm install
cp .env.example .env  # fill in DATABASE_URL, BETTER_AUTH_SECRET, SYSTEM_ADMIN_EMAILS
pnpm migrate          # initialize database schema
pnpm dev              # http://localhost:3000
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full development setup and PR process.

- All commits are signed off under the [DCO](https://developercertificate.org/) (`git commit -s`).
- See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Community & Contact

For more information, please contact [feedlog.oss@outlook.com](mailto:feedlog.oss@outlook.com).

- **GitHub Issues:** Report bugs, request features, and track development. [Submit an issue](https://github.com/linkcraftstudio/feedlog/issues)
- **Discord:** Get real-time support, chat with the community, and stay updated. [Join us](https://discord.gg/9rj64WXESn)
- **GitHub Discussions:** Share ideas, ask questions, and discuss product use cases. [Join the discussion](https://github.com/linkcraftstudio/feedlog/discussions)
- **Documentation:** Learn how to deploy, configure, and use FeedLog. [Read the docs](https://help.feedlog.ai/)
- **WeChat Community:** Scan the QR code below to join our WeChat community.

  <img src="https://cdn.feedlog.ai/se/feedlog/oss/readme/contact-us-wechat.png" alt="FeedLog WeChat community QR code" width="200" />

- **Security:** Report security vulnerabilities privately by email. See our [Security Policy](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 LinkCraft Studio

[cf-deploy-img]: https://deploy.workers.cloudflare.com/button
[cf-deploy-link]: https://deploy.workers.cloudflare.com/?url=https://github.com/linkcraftstudio/feedlog
[vercel-deploy-img]: https://vercel.com/button
[vercel-deploy-link]: https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flinkcraftstudio%2Ffeedlog&project-name=feedlog&repository-name=feedlog&env=DATABASE_URL,BETTER_AUTH_SECRET,SYSTEM_ADMIN_EMAILS&envDescription=DATABASE_URL%3A%20Postgres%20connection%20string%20with%20pgvector%20enabled%20(Neon%20or%20Supabase%20from%20the%20Vercel%20Marketplace%20works%20out%20of%20the%20box).%20BETTER_AUTH_SECRET%3A%2032%2B%20char%20random%20string%20(run%20%60openssl%20rand%20-hex%2032%60).%20SYSTEM_ADMIN_EMAILS%3A%20your%20email%2C%20granted%20admin%20role%20on%20first%20sign-up.&envLink=https%3A%2F%2Fgithub.com%2Flinkcraftstudio%2Ffeedlog%2Fblob%2Fmain%2Fdocs%2Fdeploy%2Fvercel.md
