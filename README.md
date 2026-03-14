# <!-- logo -->

# A3lix

**The weird little agent that texts your clients back with a deploy link.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot-2CA5E0?logo=telegram&logoColor=white)](https://core.telegram.org/bots)

---

## What it does

**A3lix** is an open-source **AI Agent CMS** for any Jamstack/static site. Learn more at [a3lix.com](https://a3lix.com).

Your clients simply text the agent on Telegram (or email):

> "Add a new blog post about our schnitzel menu"
> "Redesign the footer and change the brand color to orange"
> "Create a new /menu page with photos"

A3lix understands the request, edits the actual code in GitHub, and lets the requester confirm the deployment with a simple **YES/NO** choice.

Works with **Next.js, Astro, SvelteKit, Hugo, Eleventy, Remix, Gatsby, Nuxt** — basically any static/Jamstack site that lives in GitHub.

No CMS dashboard. No logins. No more "Felix fix this real quick" messages ever again.

---

## How it works

1. **Client texts** a request to your Telegram bot (e.g. _"Change the hero headline to Summer Sale is Here"_)
2. **Telegram** forwards the message to your **Cloudflare Worker** via webhook
3. **The Worker** authenticates the sender, enforces rate limits, and validates the request against the allowed-paths guardrails
4. **AI parses** the request and determines which file(s) need to change and what the new content should be
5. **The worker** stores the proposed changes and asks the requester to confirm with `YES` or `NO`
6. If they reply **YES**, A3lix commits directly to the base branch and Cloudflare Pages deploys the changes
7. If they reply **NO**, the request is cancelled and no changes are made
8. **Deployment notification** is sent back with the live site URL once changes are deployed

---

## Quick Start

```bash
npx a3lixcms@latest init
```

This interactive CLI will walk you through the entire setup in under 5 minutes:

1. **Answer the prompts** — project name, GitHub repo, Telegram bot token, Cloudflare Pages project name
2. **A3lix generates** your `agent.json` config file and `worker/.dev.vars` secrets file
3. **Deploy the worker** with `npm run deploy` (or let the CLI do it for you)
4. **Register the Telegram webhook** — the CLI does this automatically
5. **Text your bot** to confirm it's alive: _"Hey, what site is this?"_

> 💡 **Tip:** Run `npx a3lixcms@latest update` at any time to pull the latest worker code without touching your `agent.json` or secrets.

---

## Prerequisites

Before running `npx a3lixcms@latest init`, make sure you have:

- **Cloudflare account** — free tier is fine; KV must be enabled
- **GitHub repo** — a public or private repo running **Next.js** or **Astro** (other frameworks coming in v1.2)
- **Telegram bot token** — create a bot via [@BotFather](https://t.me/botfather) and copy the token
- **Cloudflare Pages project** — see [Connect GitHub to Cloudflare Pages](#connect-github-to-cloudflare-pages) below
- **xAI API key** — get one from [x.ai](https://x.ai) for Grok AI (default provider)
- **Node.js ≥ 18** installed locally (only needed to run the setup CLI)

---

## Connect GitHub to Cloudflare Pages

A3lix relies on Cloudflare Pages to automatically deploy your site when changes are pushed to the main branch. Here's how to set that up:

1. **Go to the Cloudflare dashboard** → [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**
2. Click **Create application** → **Pages** → **Connect to Git**
3. **Authorize Cloudflare** to access your GitHub account (one-time OAuth)
4. Select your **repository** (e.g. `a3lix/my-site`) and click **Begin setup**
5. **Configure your build settings:**
   - **Framework preset:** select `Astro` or `Next.js` (matching your project)
   - **Build command:** e.g. `npm run build` (auto-filled for most presets)
   - **Build output directory:** e.g. `dist` for Astro, `.next` for Next.js
6. Click **Save and Deploy** — Cloudflare will build and deploy your `main` branch
7. **Note the project name** shown at the top of the Pages project page (e.g. `my-site`) — you will need this when running `npx a3lixcms@latest init`

> ✅ **Production deployments happen automatically.** When A3lix pushes changes to your main branch, Cloudflare Pages will rebuild and deploy your site within 2-5 minutes.

> 💡 **Tip:** You can monitor deployment status in your Cloudflare Pages dashboard.

---

## Configuration

After running `npx a3lixcms@latest init`, an `agent.json` file will be created in your project root. **Never commit this file** — it is already in `.gitignore`.

| Field | Type | Description |
|-------|------|-------------|
| `project.name` | `string` | Display name shown in bot replies |
| `project.repo` | `string` | GitHub repo in `owner/name` format |
| `project.branch` | `string` | Production branch (usually `main`) |
| `project.framework` | `"astro" \| "nextjs"` | Used to resolve content paths correctly |
| `bot.platform` | `"telegram"` | Messaging platform (only Telegram in v0.1) |
| `bot.ownerChatId` | `string` | Your Telegram chat ID — receives notifications |
| `ai.provider` | `string` | AI provider: `grok`, `workers-ai`, `openai`, `claude`, `groq`, `gemini` |
| `ai.model` | `string` | Model identifier for the chosen provider |
| `ai.apiKey` | `string` | API key — required for all providers except `workers-ai` |
| `paths.allowed` | `string[]` | Paths the agent is permitted to modify |
| `roles.editors` | `string[]` | Telegram chat IDs of editors (can request changes) |
| `roles.viewers` | `string[]` | Telegram chat IDs of viewers (read-only status) |
| `limits.changesPerUserPerDay` | `number` | Max change requests per user per 24 h |
| `cloudflare.pagesProjectName` | `string` | Cloudflare Pages project name (from your dashboard) |
| `cloudflare.customDomain` | `string` | Custom domain for your Pages project (optional, falls back to pages.dev) |

---

## User Roles

A3lix has three user roles enforced at the Worker level. Role membership is defined by Telegram Chat ID in `agent.json`.

| Role | Who | What they can do |
|------|-----|-----------------|
| **Owner** | The site owner (you) | View audit log, access all commands, manage roles via `/addeditor` and `/addviewer` |
| **Editor** | Trusted clients / team members | Request content changes and confirm deployments with YES/NO |
| **Viewer** | Stakeholders / read-only observers | Query current content (`/status`), receive deployment notifications — cannot request changes |

---

## Security

A3lix is designed with defence-in-depth: path guardrails prevent modifications outside `src/content`, `src/pages`, `public`, and `tailwind.config.*` by default, and a destructive-keyword blocklist blocks requests containing patterns like `rm -rf`, `drop`, `.env`, or `process.env`. The YES/NO confirmation step allows users to review changes before deployment.

See [`docs/SECURITY.md`](./docs/SECURITY.md) for the full threat model, GitHub token scoping requirements, rate limiting details, audit log format, and the pre-launch security checklist.

---

## Supported AI Providers

A3lix ships with **xAI Grok** as the default — excellent content generation with good context understanding. Other options available:

| Provider | `ai.provider` value | Notes |
|----------|-------------------|-------|
| **xAI Grok** _(default)_ | `grok` | Requires `AI_API_KEY` secret; model e.g. `grok-2-latest` |
| **Workers AI** | `workers-ai` | Free tier included; model: `@cf/meta/llama-3.3-70b-instruct-fp8` |
| **OpenAI** | `openai` | Requires `OPENAI_API_KEY` secret; model e.g. `gpt-4o` |
| **Anthropic Claude** | `claude` | Requires `AI_API_KEY` secret; model e.g. `claude-3-5-sonnet-20241022` |
| **Groq** | `groq` | Requires `AI_API_KEY` secret; model e.g. `llama-3.3-70b-versatile` |
| **Google Gemini** | `gemini` | Requires `AI_API_KEY` secret; model e.g. `gemini-2.0-flash` |

To switch providers, update `ai.provider` and `ai.model` in `agent.json`, add the API key via `wrangler secret put AI_API_KEY`, then redeploy.

> 💡 **Default**: A3lix uses xAI Grok by default. The model provides excellent content generation capabilities with good context understanding.

---

## Roadmap

| Version | Status | What's in it |
|---------|--------|-------------|
| **v0.1 — MVP** | ✅ Completed | Telegram webhook, Workers AI, GitHub direct deployment, Cloudflare Pages integration, KV rate limiting, path guardrails |
| **v1.1 — Email Workers** | 📋 Planned | Inbound email via Cloudflare Email Workers as an alternative to Telegram |
| **v1.2 — Vercel / Netlify Deployers** | 📋 Planned | Pluggable deployer interface; first-class support for Vercel and Netlify deployments |
| **v2.0 — Vision & Screenshots** | 💡 Idea | Multimodal AI: clients can send a photo of a design mock-up or a screenshot of a bug and the agent acts on it |

---

## Contributing

Contributions are welcome and appreciated! To get started:

1. Fork the repo and create a feature branch: `git checkout -b feat/my-feature`
2. Make your changes — please keep commits focused and descriptive
3. Run `npm run lint` and `npm run build` to make sure everything passes
4. Open a Pull Request against `main` with a clear description of what and why

Please read the [Code of Conduct](./docs/CODE_OF_CONDUCT.md) before contributing. For security vulnerabilities, see the responsible disclosure section in [`docs/SECURITY.md`](./docs/SECURITY.md) — **do not** open a public issue for security bugs.

---

## License

[MIT](./LICENSE) © 2026 A3lix Contributors
