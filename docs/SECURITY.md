# A3lix Security Documentation

> This document describes the security architecture of A3lix. If you discover a vulnerability, please follow the [Reporting Vulnerabilities](#reporting-vulnerabilities) process — **do not** open a public GitHub issue.

---

## Table of Contents

1. [Threat Model](#threat-model)
2. [GitHub Token Scoping](#github-token-scoping)
3. [Path Restrictions](#path-restrictions)
4. [Destructive Keyword Blocklist](#destructive-keyword-blocklist)
5. [Rate Limiting](#rate-limiting)
6. [Approval Flow](#approval-flow)
7. [Role Enforcement](#role-enforcement)
8. [OTP Whitelist Flow](#otp-whitelist-flow)
9. [Audit Log](#audit-log)
10. [Webhook Security](#webhook-security)
11. [Update System Safety](#update-system-safety)
12. [Security Checklist](#security-checklist)
13. [Reporting Vulnerabilities](#reporting-vulnerabilities)

---

## Threat Model

A3lix sits between public Telegram users and your private GitHub repository. The primary threat surface is:

| Threat | Mitigation |
|--------|-----------|
| **Unauthorised user sends messages** | All incoming Telegram chat IDs are checked against `agent.json` role lists; unknown IDs receive no response and are logged |
| **Authorised user requests destructive change** | Destructive keyword blocklist rejects requests containing dangerous patterns before AI processing |
| **AI hallucinates a path outside allowed directories** | `guardrails.ts` performs a hard path check on every proposed file write — no exceptions |
| **Secrets leaked via git** | `agent.json` and `.dev.vars` are in `.gitignore`; `npx a3lixcms@latest update` never touches them |
| **Compromised GitHub token used to deploy malware** | Fine-grained PAT is scoped to a single repo and only Contents + Workflows permissions |
| **Webhook spoofing** | Every inbound Telegram webhook is verified against `X-Telegram-Bot-Api-Secret-Token` |
| **Replay or flood attacks** | KV-backed per-user rate limiting rejects excess requests within a 24-hour window |
| **Accidental production changes** | Use `PREVIEW` mode for human review before merge; restrict editor access; monitor audit logs |

---

## GitHub Token Scoping

A3lix uses a **GitHub Fine-Grained Personal Access Token** (not a classic PAT). This is mandatory — classic PATs grant too much access.

### Required permissions (nothing else)

| Permission | Access level | Reason |
|-----------|--------------|--------|
| **Contents** | Read & Write | Read existing files; push preview branches; merge approved branches |
| **Workflows** | Read & Write | Required if the repo uses GitHub Actions for builds or deployments |

### How to create the token

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Set **Resource owner** to the account or organisation that owns the repo
4. Under **Repository access**, choose **Only select repositories** and pick your site repo
5. Under **Permissions**, expand **Repository permissions** and set:
   - `Contents` → **Read and write**
   - `Workflows` → **Read and write**
   - Leave everything else at **No access**
6. Click **Generate token**, copy it, and store it with `wrangler secret put GITHUB_TOKEN`

> ⚠️ **Never** use a classic PAT. Classic PATs cannot be scoped to a single repository and grant access to all your repos.

---

## Path Restrictions

The `guardrails.ts` module (in `worker/src/`) enforces an allowlist of paths that the agent is permitted to read or write. The allowlist is loaded from `agent.json` at runtime:

```
paths.allowed:
  - src/content
  - src/components
  - src/pages
  - public
  - tailwind.config.*
```

### How enforcement works

1. After the AI parses the user request and produces a list of proposed file operations, each target path is passed to `validatePath(filePath, allowedPaths)`.
2. `validatePath` resolves the path relative to the repository root and checks that it begins with one of the entries in `paths.allowed`.
3. Path traversal sequences (`../`, `%2e%2e`, URL-encoded variants) are detected and immediately rejected.
4. **If any path fails validation**, the entire request is aborted — no partial changes are made. The user receives: _"That request would modify files outside the allowed paths. Please contact your site owner to expand the allowed paths list."_
5. The violation is written to the [Audit Log](#audit-log) with the offending path.

### Expanding the allowlist

Only the site owner can modify `agent.json`. Before adding a path, consider:
- Is it a path that could expose application logic or secrets? (e.g. `src/lib`, `src/env.ts` — **do not add**)
- Could a change to this path break the build or compromise security? If unsure, keep the defaults.

---

## Destructive Keyword Blocklist

A3lix runs a pattern-matching pre-filter on every incoming request **before** it is sent to the AI. Requests containing any of the following patterns are rejected immediately with the message: _"That request contains prohibited keywords and cannot be processed."_

| Pattern | Reason blocked |
|---------|---------------|
| `delete` | Ambiguous destructive intent |
| `drop` | SQL/DB destruction |
| `rm -rf` | Shell file deletion |
| `truncate` | File/DB truncation |
| `format` | Disk/storage format |
| `wipe` | Mass deletion |
| `destroy` | General destructive term |
| `__secret` | Secret variable naming convention |
| `.env` | Environment file reference |
| `process.env` | Node.js secret access pattern |
| `import.meta.env` | Vite/Astro secret access pattern |
| `GITHUB_TOKEN` | GitHub token reference |
| `TELEGRAM_BOT_TOKEN` | Telegram token reference |
| `eval(` | Code injection |
| `<script` | XSS injection |
| `javascript:` | URL-based XSS |
| `data:text/html` | Data URI injection |

The blocklist is case-insensitive. All blocked requests are logged to the audit log with the matched pattern.

> **Note:** This blocklist is a defence-in-depth measure, not the primary security control. The AI itself is also instructed via system prompt to refuse destructive requests, and path restrictions provide a final backstop.

---

## Rate Limiting

Rate limits are enforced per Telegram chat ID using Cloudflare KV, which provides globally consistent counters with TTL-based expiry.

### How it works

1. On each request, the worker reads the key `rate:<chatId>:<YYYY-MM-DD>` from KV.
2. If the value is absent, the counter is initialised to `0` with a TTL of `86400` seconds (24 hours), automatically expiring at midnight UTC.
3. If the counter is **≥ `limits.changesPerUserPerDay`** (from `agent.json`), the request is rejected: _"You've reached your daily limit of X change requests. Resets at midnight UTC."_
4. Otherwise, the counter is incremented and the request proceeds.

### Default limits

| Limit | Default | Field in `agent.json` |
|-------|---------|----------------------|
| Changes per user per day | `5` | `limits.changesPerUserPerDay` |
| Preview branch expiry | `24` hours | `limits.previewExpiryHours` |

Pending preview approvals expire from KV after `previewExpiryHours` (and are also filtered by `expiresAt`) to prevent stale approval prompts.

---

## Approval Flow

A3lix currently supports two deployment paths:

1. A requester sends a change request.
2. The worker parses and validates the proposed file changes.
3. The requester is prompted to choose `LIVE` or `PREVIEW`.
4. If `LIVE` is chosen, changes are committed directly to the base branch.
5. If `PREVIEW` is chosen, a preview branch is created and a Pages preview URL is returned.
6. For previews, replying `YES` merges to `main`; replying `NO` discards the pending approval record.

> **Safety guidance:** Treat `PREVIEW` as the recommended production workflow so a human can validate changes before merge.

---

## Role Enforcement

Roles are enforced at the Worker level on every request, not just at the Telegram bot level.

| Role | Can request changes | Can approve changes | Can manage roles | Can view audit log |
|------|--------------------|--------------------|-----------------|-------------------|
| **Owner** | ✅ | ✅ | ✅ | ✅ |
| **Editor** | ✅ | ✅ (for their own pending preview) | ❌ | ❌ |
| **Viewer** | ❌ | ❌ | ❌ | ❌ |

### Key enforcement rules

- **Owner can always act on pending previews.** The owner may approve/reject previews regardless of who requested them.
- **Requester can act on their own pending preview.** Editors can approve/reject their own preview submission.
- **Viewers are strictly read-only.** Any command from a viewer that would cause a write operation is rejected.
- **Unknown chat IDs receive no response.** The worker returns HTTP 200 to Telegram (to prevent retries) but takes no action and logs the unknown ID.

---

## OTP Whitelist Flow

New users are onboarded via a one-time password (OTP) challenge to prevent unauthorised users from adding themselves as editors or viewers.

### Step-by-step flow

1. The site owner runs `/addeditor` or `/addviewer` in the Telegram bot, which generates a 6-digit OTP and stores it in KV with a 10-minute TTL.
2. The owner shares the OTP out-of-band with the new user (e.g. via email or in person).
3. The new user messages the bot: `/join <OTP>`
4. The worker looks up the OTP in KV:
   - **Valid and not expired**: The user's Telegram chat ID is added to the appropriate role list. The OTP is deleted from KV immediately (single-use). The owner receives a confirmation notification.
   - **Invalid or expired**: The request is rejected. The failed attempt is logged with the chat ID and timestamp.
5. OTPs cannot be reused. A new `/addeditor` or `/addviewer` command generates a fresh OTP.

> **Note:** In v0.1, the role list is stored in KV and synced back to `agent.json` by the setup CLI. Modifying `agent.json` manually and redeploying also works.

---

## Audit Log

Every significant action is written to Cloudflare KV under the key prefix `audit:<timestamp>:<chatId>`. Log entries are JSON objects:

```jsonc
{
  "timestamp": "2026-03-08T14:23:01.000Z",  // ISO 8601 UTC
  "chatId": "123456789",                      // Telegram chat ID of actor
  "role": "editor",                           // Role at time of action
  "action": "CHANGE_REQUESTED",               // Action type (see below)
  "filePaths": ["src/content/blog/post.md"],  // Files affected (if applicable)
  "branch": "preview-update-hero-abc123",     // Branch name (if applicable)
  "approved": null,                           // null | true | false
  "metadata": {}                              // Additional context
}
```

### Action types

| Action | Triggering event |
|--------|----------------|
| `CHANGE_REQUESTED` | User submits a change request |
| `CHANGE_APPROVED` | Owner or requester sends `YES` on a pending preview |
| `CHANGE_REJECTED` | Owner or requester sends `NO` on a pending preview |
| `CHANGE_BLOCKED_PATH` | Request blocked by path guardrail |
| `CHANGE_BLOCKED_KEYWORD` | Request blocked by keyword filter |
| `RATE_LIMIT_HIT` | User exceeds daily change limit |
| `UNKNOWN_USER` | Message received from unknown chat ID |
| `OTP_ISSUED` | Owner issued an OTP for a new user |
| `OTP_REDEEMED` | New user redeemed an OTP successfully |
| `OTP_FAILED` | Invalid or expired OTP attempt |
| `APPROVAL_SPOOFED` | Unauthorized user attempted to approve/reject a pending preview |

Audit log entries are retained in KV for 30 days, after which they expire automatically via KV TTL. The owner can query recent logs with the `/audit` bot command.

---

## Webhook Security

Telegram webhooks are authenticated using the `X-Telegram-Bot-Api-Secret-Token` header:

1. During setup, a cryptographically random 256-bit string is generated and stored as the `TELEGRAM_SECRET_TOKEN` wrangler secret.
2. When registering the webhook with Telegram's `setWebhook` API, the `secret_token` parameter is set to this value.
3. On every inbound webhook request, the worker reads the `X-Telegram-Bot-Api-Secret-Token` header and compares it to `TELEGRAM_SECRET_TOKEN` using a constant-time comparison to prevent timing attacks.
4. **If the header is absent or does not match**, the worker returns HTTP 401 immediately — no processing occurs.

This ensures that only Telegram (which knows the secret token) can trigger the worker, even if an attacker knows your worker's public URL.

---

## Update System Safety

Running `npx a3lixcms@latest update` fetches and applies the latest worker code from the npm registry. The update system is designed to be non-destructive:

### Files the updater will NEVER touch

- `agent.json` — your configuration
- `.dev.vars` — your local secrets
- Any wrangler secrets set via `wrangler secret put` — these live in Cloudflare's encrypted secrets store, not in the filesystem
- `worker/wrangler.toml` — your KV namespace IDs and binding names

### Files the updater WILL replace

- `worker/src/**/*.ts` — the worker source code
- `deployers/**/*.ts` — deployer interface stubs
- `setup/**/*.ts` — the CLI setup scripts

The updater always shows a diff of what will change and asks for confirmation before applying any update.

---

## Security Checklist

Run through this checklist before going live with A3lix:

- [ ] `agent.json` is in `.gitignore` and **not committed** to the repository
- [ ] `.dev.vars` is in `.gitignore` and **not committed** to the repository
- [ ] GitHub PAT is a fine-grained token scoped to **only** the target repo with only Contents + Workflows permissions
- [ ] `GITHUB_TOKEN` is stored as a wrangler secret (`wrangler secret put GITHUB_TOKEN`), not in `wrangler.toml` vars
- [ ] `TELEGRAM_BOT_TOKEN` is stored as a wrangler secret, not in `wrangler.toml` vars
- [ ] `TELEGRAM_SECRET_TOKEN` is set and the webhook was registered with `secret_token` parameter
- [ ] `bot.ownerChatId` is set to **your** Telegram chat ID (not a group or channel)
- [ ] Team members use `PREVIEW` (not `LIVE`) for production changes requiring human verification
- [ ] `paths.allowed` contains only the minimum paths needed (do **not** add `src/lib`, `src/env.ts`, etc.)
- [ ] You have reviewed the `roles.editors` and `roles.viewers` lists and removed any stale chat IDs
- [ ] Workers AI (or your chosen AI provider) is enabled and the API key (if required) is stored as `AI_API_KEY` secret
- [ ] KV namespace IDs in `wrangler.toml` are set to real IDs (not the placeholder values)
- [ ] You have sent a test message to the bot and confirmed the audit log is being written to KV
- [ ] You have tested the `NO` preview flow and confirmed pending approval state is removed

---

## Reporting Vulnerabilities

A3lix takes security seriously. If you discover a vulnerability, please **do not** open a public GitHub issue.

Instead, send details to: **security@a3lix.com**

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept code or screenshots are helpful)
- Any suggested mitigations you have in mind

We will acknowledge your report within 48 hours and aim to release a fix within 14 days for critical issues. We follow coordinated disclosure: we will notify you before publishing any fix so you can review the patch.

We do not currently have a formal bug bounty programme, but we will publicly credit researchers (with your consent) in the release notes.
