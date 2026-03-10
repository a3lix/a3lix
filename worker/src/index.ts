/// <reference types="@cloudflare/workers-types" />

/**
 * @module index
 *
 * Main Cloudflare Worker entry point for A3lix.
 *
 * This module is the integration hub — it receives all HTTP requests, verifies
 * Telegram webhook signatures, loads the agent config from KV, and orchestrates
 * all other modules (guardrails, roles, parser, deployer, replies).
 *
 * Route table:
 *   POST /telegram  →  handleTelegramWebhook
 *   POST /email     →  handleEmailWebhook (stub, v1.1)
 *   GET  /health    →  health check JSON
 *   *               →  404
 *
 * Design principles:
 *   - Always return HTTP 200 to Telegram within 3 seconds.
 *     Heavy async work (AI parse + GitHub deploy) runs in ctx.waitUntil().
 *   - Never expose internal error details to end-users.
 *   - No `any` — all unknown values are narrowed before use.
 */

import {
  checkRateLimit,
  checkAllowedPaths,
  checkDestructiveKeywords,
  checkOperationAllowed,
  runAllGuardrails,
  auditLog,
  type FileChange,
  type GuardrailConfig,
} from './guardrails';

import {
  getUserRole,
  checkAccess,
  canApproveChange,
  initiateAccessRequest,
  generateOtp,
  validateOtp,
  completeOnboarding,
  bootstrapOwner,
  type Role,
} from './roles';

import {
  parse,
  type AiConfig,
  type ParseResult,
} from './parser';

import {
  type GitHubConfig,
  type GitHubFileChange,
  storePendingApproval,
  getPendingApproval,
  deletePendingApproval,
  listPendingApprovals,
  type PendingApproval,
  GitHubError,
} from './github';

import {
  deployPreview,
  approveAndMerge,
  type DeployConfig,
} from './deployer';

import {
  sendTelegramMessage,
  replyUnknownUser,
  replyOwnerApprovalNeeded,
  replyOtpIssued,
  replyOtpInvalid,
  replyWelcomeEditor,
  replyParsing,
  replyUnknownIntent,
  replyNeedsClarification,
  replyPreviewReady,
  replyApprovalPending,
  replyMerged,
  replyCancelled,
  replyNoPendingApproval,
  replyViewerCannotEdit,
  replyRateLimited,
  replyGuardrailBlocked,
  replyPathBlocked,
  replyInternalError,
  replyGitHubError,
  replyStatusCheck,
} from './replies';

// ---------------------------------------------------------------------------
// Env interface — single source of truth for all Worker bindings
// ---------------------------------------------------------------------------

/**
 * Cloudflare Worker environment bindings for A3lix.
 *
 * Bindings are declared in `wrangler.toml` and secrets are set via
 * `wrangler secret put`. The `AgentConfig` is loaded at runtime from KV.
 */
export interface Env {
  // ── Cloudflare bindings ──────────────────────────────────────────────────
  /** Workers AI binding — used for `workers-ai` provider. */
  AI: Ai;
  /** KV namespace for rate limits, roles, OTPs, approvals, and audit logs. */
  A3LIX_KV: KVNamespace;

  // ── Secrets (set via `wrangler secret put`) ──────────────────────────────
  /** Fine-grained GitHub Personal Access Token with repo read/write access. */
  GITHUB_TOKEN: string;
  /** Telegram Bot API token from @BotFather. */
  TELEGRAM_BOT_TOKEN: string;
  /** Shared secret set in the Telegram webhook URL to verify request origin. */
  TELEGRAM_SECRET_TOKEN: string;
  /** API key for non-Workers-AI providers (openai, claude, grok, groq, gemini). */
  AI_API_KEY: string;

  // ── Vars (from `wrangler.toml [vars]`) ───────────────────────────────────
  /** Runtime environment name, e.g. `"production"` or `"development"`. */
  ENVIRONMENT: string;
  /** Logging verbosity level, e.g. `"info"`, `"debug"`, `"error"`. */
  LOG_LEVEL: string;
}

// ---------------------------------------------------------------------------
// AgentConfig — loaded from KV key "config" on each request
// ---------------------------------------------------------------------------

/**
 * Agent configuration loaded from KV at request time.
 * Bootstrapped by `npx a3lix init` and stored under KV key `"config"`.
 */
interface AgentConfig {
  project: {
    /** Human-readable project name. */
    name: string;
    /** GitHub repository in `"owner/repo"` format. */
    repo: string;
    /** Base branch for deployments, e.g. `"main"`. */
    branch: string;
    /** Frontend framework powering the site. */
    framework: 'astro' | 'nextjs';
  };
  bot: {
    /** Messaging platform (only Telegram supported in v0.1). */
    platform: 'telegram';
    /** Telegram chat ID of the site owner (stored as a string). */
    ownerChatId: string;
  };
  ai: {
    /** AI inference provider. */
    provider: 'workers-ai' | 'openai' | 'claude' | 'grok' | 'groq' | 'gemini';
    /** Model identifier for the chosen provider. */
    model: string;
    /** API key — required for all providers except `workers-ai`. */
    apiKey?: string;
  };
  paths: {
    /** Repo-relative path prefixes the agent is permitted to write to. */
    allowed: string[];
  };
  limits: {
    /** Maximum change-sets a single user may submit per day (UTC). */
    changesPerUserPerDay: number;
    /** How many hours a Cloudflare Pages preview link stays valid. */
    previewExpiryHours: number;
    /** If true, every change needs owner approval regardless of who requested it. */
    requireApprovalForAll: boolean;
  };
  cloudflare: {
    /** Cloudflare Pages project name used to build preview URLs. */
    pagesProjectName: string;
  };
}

// ---------------------------------------------------------------------------
// Telegram Update types — defined locally, no external library dependency
// ---------------------------------------------------------------------------

/** A Telegram user record as returned in message payloads. */
interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

/** A single Telegram message object. */
interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  date: number;
}

/** A Telegram Update object sent by the Telegram webhook. */
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Narrows an `unknown` value to confirm it matches the essential shape of
 * {@link AgentConfig}. Only checks the fields critical for runtime operation.
 *
 * @param value - The value to test.
 * @returns `true` when `value` is a valid `AgentConfig`.
 */
function isAgentConfig(value: unknown): value is AgentConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;

  // project
  if (typeof v['project'] !== 'object' || v['project'] === null) return false;
  const project = v['project'] as Record<string, unknown>;
  if (typeof project['repo'] !== 'string') return false;
  if (typeof project['branch'] !== 'string') return false;
  if (project['framework'] !== 'astro' && project['framework'] !== 'nextjs') return false;

  // bot
  if (typeof v['bot'] !== 'object' || v['bot'] === null) return false;
  const bot = v['bot'] as Record<string, unknown>;
  if (typeof bot['ownerChatId'] !== 'string') return false;

  // ai
  if (typeof v['ai'] !== 'object' || v['ai'] === null) return false;
  const ai = v['ai'] as Record<string, unknown>;
  if (typeof ai['provider'] !== 'string') return false;
  if (typeof ai['model'] !== 'string') return false;

  // paths
  if (typeof v['paths'] !== 'object' || v['paths'] === null) return false;
  const paths = v['paths'] as Record<string, unknown>;
  if (!Array.isArray(paths['allowed'])) return false;

  // limits
  if (typeof v['limits'] !== 'object' || v['limits'] === null) return false;
  const limits = v['limits'] as Record<string, unknown>;
  if (typeof limits['changesPerUserPerDay'] !== 'number') return false;

  // cloudflare
  if (typeof v['cloudflare'] !== 'object' || v['cloudflare'] === null) return false;
  const cloudflare = v['cloudflare'] as Record<string, unknown>;
  if (typeof cloudflare['pagesProjectName'] !== 'string') return false;

  return true;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Loads and parses the {@link AgentConfig} from KV key `"config"`.
 *
 * @param kv - The `KVNamespace` binding (A3LIX_KV).
 * @returns The parsed and validated {@link AgentConfig}.
 * @throws `Error` when the config key is missing, non-JSON, or fails the
 *         {@link isAgentConfig} type guard.
 */
async function loadConfig(kv: KVNamespace): Promise<AgentConfig> {
  const raw = await kv.get('config');

  if (raw === null) {
    throw new Error('Agent not configured. Run npx a3lix init first.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Agent not configured. Run npx a3lix init first.');
  }

  if (!isAgentConfig(parsed)) {
    throw new Error('Agent not configured. Run npx a3lix init first.');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Telegram webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies that an incoming request is a genuine Telegram webhook delivery
 * by comparing the `X-Telegram-Bot-Api-Secret-Token` header against the
 * configured `secretToken` using a constant-time char-by-char comparison.
 *
 * @param request     - The incoming HTTP request.
 * @param secretToken - The expected token value set when registering the webhook.
 * @returns `true` when the header is present and matches; `false` otherwise.
 */
function verifyTelegramWebhook(request: Request, secretToken: string): boolean {
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (header === null) return false;
  if (header.length !== secretToken.length) return false;

  // Constant-time comparison — iterate char-by-char to avoid timing attacks.
  let mismatch = 0;
  for (let i = 0; i < secretToken.length; i++) {
    mismatch |= (header.charCodeAt(i) ?? 0) ^ secretToken.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// GitHub config helper
// ---------------------------------------------------------------------------

/**
 * Builds a {@link GitHubConfig} from the Worker env token and agent config.
 *
 * @param token      - The `GITHUB_TOKEN` secret from the Worker env.
 * @param repo       - The `"owner/repo"` string from {@link AgentConfig}.
 * @param baseBranch - The base branch name from {@link AgentConfig}.
 * @returns A fully populated {@link GitHubConfig}.
 * @throws `Error` when `repo` does not contain exactly one `/` separator.
 */
function buildGitHubConfig(
  token: string,
  repo: string,
  baseBranch: string,
): GitHubConfig {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid repo format "${repo}". Expected "owner/repo".`,
    );
  }

  return {
    token,
    owner: parts[0],
    repo: parts[1],
    baseBranch,
  };
}

// ---------------------------------------------------------------------------
// Change request handler — runs inside ctx.waitUntil()
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full AI-parse → guardrail → deploy → notify pipeline for
 * a user change request. Designed to run inside `ctx.waitUntil()` so it can
 * take up to 30 seconds without blocking the Telegram 200 response.
 *
 * Steps:
 *   1. Build `AiConfig` from `config.ai`.
 *   2. Call `parse()` → `ParseResult`.
 *   3. Handle unknown intent, status check, and clarification cases.
 *   4. Run `runAllGuardrails()` → block or continue.
 *   5. Call `deployPreview()` to push the branch to GitHub.
 *   6. Store `PendingApproval` in KV.
 *   7. Notify requesting user + owner.
 *   8. Write `last_deploy` timestamp and audit log.
 *
 * All errors are caught: `GitHubError` → github-specific message,
 * anything else → generic internal error.
 *
 * @param text        - Raw message text from the Telegram user.
 * @param userId      - Telegram user ID (string form).
 * @param chatId      - Telegram chat ID to reply to.
 * @param displayName - Telegram username or first name, used in notifications.
 * @param config      - Loaded {@link AgentConfig}.
 * @param env         - Worker {@link Env} bindings.
 */
async function handleChangeRequest(
  text: string,
  userId: string,
  chatId: number,
  displayName: string | undefined,
  config: AgentConfig,
  env: Env,
): Promise<void> {
  try {
    // ── 1. Build AiConfig ────────────────────────────────────────────────────
    const aiConfig: AiConfig = {
      provider: config.ai.provider,
      model: config.ai.model,
      ...(config.ai.apiKey !== undefined ? { apiKey: config.ai.apiKey } : {}),
    };

    // Use AI_API_KEY from env if the config doesn't specify one.
    if (!aiConfig.apiKey && env.AI_API_KEY) {
      aiConfig.apiKey = env.AI_API_KEY;
    }

    // ── 2. Fetch repo file tree for accurate path targeting ───────────────────
    let fileTree: string | undefined;
    try {
      const repoParts = config.project.repo.split('/');
      const treeUrl = `https://api.github.com/repos/${config.project.repo}/git/trees/${config.project.branch}?recursive=1`;
      const treeResp = await fetch(treeUrl, {
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'A3lix-Bot/0.1',
        },
      });
      if (treeResp.ok) {
        const treeData = await treeResp.json() as { tree?: Array<{ path: string; type: string }> };
        const allowedExts = /\.(tsx?|jsx?|astro|mdx?|json|css|html)$/;
        const files = (treeData.tree ?? [])
          .filter(f => f.type === 'blob' && allowedExts.test(f.path) && !f.path.includes('node_modules') && !f.path.includes('.next') && !f.path.startsWith('.'))
          .map(f => f.path)
          .slice(0, 80); // cap at 80 files to keep prompt short
        fileTree = files.join('\n');
      }
    } catch {
      // Non-fatal — proceed without file tree
    }

    // ── 3. Parse ─────────────────────────────────────────────────────────────
    const parseResult: ParseResult = await parse({
      message: text,
      framework: config.project.framework,
      aiConfig,
      aiBinding: env.AI,
      ...(fileTree !== undefined ? { fileTree } : {}),
    });

    const { intent, changes, summary, clarifications } = parseResult;

    // ── 3a. Unknown intent ────────────────────────────────────────────────────
    if (intent.type === 'unknown') {
      await sendTelegramMessage({
        chatId,
        text: replyUnknownIntent(),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });
      return;
    }

    // ── 3b. Status check (shouldn't reach here but handle gracefully) ─────────
    if (intent.type === 'status_check') {
      return;
    }

    // ── 3c. No file changes required (edge case) ──────────────────────────────
    if (!intent.requiresFileChanges) {
      await sendTelegramMessage({
        chatId,
        text: replyUnknownIntent(),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });
      return;
    }

    // ── 3d. Low confidence — ask for clarification ───────────────────────────
    if (clarifications && clarifications.length > 0) {
      await sendTelegramMessage({
        chatId,
        text: replyNeedsClarification(clarifications),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });
      return;
    }

    // ── 4. Map ParseResult.changes → FileChange[] ────────────────────────────
    // parser.ts FileChange.operation is 'create' | 'update' (no 'delete').
    // guardrails.ts FileChange.operation adds 'delete'. Cast safely.
    const fileChanges: FileChange[] = changes.map((c) => ({
      path: c.path,
      content: c.content,
      operation: c.operation as 'create' | 'update' | 'delete',
    }));

    // Guard: AI returned no file changes — ask user to rephrase.
    if (fileChanges.length === 0) {
      console.error('[a3lix] handleChangeRequest: generateFileChanges returned empty array for intent:', intent.type);
      await sendTelegramMessage({
        chatId,
        text: replyUnknownIntent(),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });
      return;
    }

    // ── 5. Run all guardrails ─────────────────────────────────────────────────
    const guardrailConfig: GuardrailConfig = {
      allowedPaths: config.paths.allowed,
      changesPerUserPerDay: config.limits.changesPerUserPerDay,
    };

    const guardrailResult = await runAllGuardrails({
      changes: fileChanges,
      userId,
      kv: env.A3LIX_KV,
      config: guardrailConfig,
    });

    if (!guardrailResult.allowed) {
      await sendTelegramMessage({
        chatId,
        text: replyGuardrailBlocked(guardrailResult.reason ?? 'unknown'),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });

      await auditLog({
          userId,
          action: 'change_request',
          paths: fileChanges.map((c) => c.path),
          outcome: 'blocked',
          ...(guardrailResult.reason !== undefined ? { reason: guardrailResult.reason } : {}),
          kv: env.A3LIX_KV,
        });
      return;
    }

    // ── 6. Build GitHub and Deploy configs ────────────────────────────────────
    const githubConfig = buildGitHubConfig(
      env.GITHUB_TOKEN,
      config.project.repo,
      config.project.branch,
    );

    const deployConfig: DeployConfig = {
      pagesProjectName: config.cloudflare.pagesProjectName,
      framework: config.project.framework,
    };

    // Filter out 'delete' operations before passing to deployer (safety net).
    const githubChanges: GitHubFileChange[] = fileChanges
      .filter((c): c is FileChange & { operation: 'create' | 'update' } =>
        c.operation === 'create' || c.operation === 'update',
      )
      .map((c) => ({
        path: c.path,
        content: c.content,
        operation: c.operation,
      }));

    // ── 7. Deploy preview branch ──────────────────────────────────────────────
    const deployResult = await deployPreview({
      githubConfig,
      deployConfig,
      userId,
      changes: githubChanges,
      summary,
    });

    // ── 8. Store pending approval ─────────────────────────────────────────────
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const pendingApproval: PendingApproval = {
      branchName: deployResult.branchName,
      requestedByUserId: userId,
      requestedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      changes: githubChanges,
      summary,
      pagesProjectName: config.cloudflare.pagesProjectName,
    };

    await storePendingApproval(deployResult.branchName, pendingApproval, env.A3LIX_KV);

    // ── 9. Write last_deploy timestamp ────────────────────────────────────────
    await env.A3LIX_KV.put('last_deploy', now.toISOString());

    // ── 10. Notify requesting user ────────────────────────────────────────────
    await sendTelegramMessage({
      chatId,
      text: replyPreviewReady({
        summary,
        previewUrl: deployResult.previewUrl,
        estimatedSeconds: deployResult.estimatedBuildSeconds,
        branchName: deployResult.branchName,
      }),
      botToken: env.TELEGRAM_BOT_TOKEN,
    });

    // ── 11. Notify owner if request came from a non-owner user ───────────────
    if (userId !== config.bot.ownerChatId) {
      await sendTelegramMessage({
        chatId: config.bot.ownerChatId,
        text: replyApprovalPending(deployResult.previewUrl),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });
    }

    // ── 12. Audit log — allowed ───────────────────────────────────────────────
    await auditLog({
      userId,
      action: 'change_request',
      paths: githubChanges.map((c) => c.path),
      outcome: 'allowed',
      kv: env.A3LIX_KV,
    });
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      await sendTelegramMessage({
        chatId,
        text: replyGitHubError(error.endpoint),
        botToken: env.TELEGRAM_BOT_TOKEN,
      }).catch(() => undefined);
    } else {
      await sendTelegramMessage({
        chatId,
        text: replyInternalError(),
        botToken: env.TELEGRAM_BOT_TOKEN,
      }).catch(() => undefined);
    }

    // Audit log — error
    await auditLog({
      userId,
      action: 'change_request',
      paths: [],
      outcome: 'blocked',
      reason: error instanceof Error ? error.message : 'unknown error',
      kv: env.A3LIX_KV,
    }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Main message router
// ---------------------------------------------------------------------------

/**
 * Routes a Telegram message to the correct handler based on user role and
 * message content.
 *
 * All heavy async work is deferred via `ctx.waitUntil()` so the 200 response
 * can be returned to Telegram immediately.
 *
 * Role dispatch:
 *   UNKNOWN  → OTP validation or access request flow
 *   OWNER    → approval of pending site changes or access requests
 *   EDITOR   → change requests (guarded by rate limit + guardrails)
 *   VIEWER   → status check only
 *
 * @param text        - Trimmed message text.
 * @param userId      - Telegram user ID (string form).
 * @param chatId      - Telegram chat ID of the sender.
 * @param displayName - Telegram username or first name.
 * @param config      - The loaded {@link AgentConfig}.
 * @param env         - Worker {@link Env} bindings.
 * @param ctx         - Worker execution context (for `waitUntil`).
 */
async function routeMessage(
  text: string,
  userId: string,
  chatId: number,
  displayName: string | undefined,
  config: AgentConfig,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // ── 1. Determine user role ────────────────────────────────────────────────
  const role = await getUserRole(userId, env.A3LIX_KV);

  // ── 2. UNKNOWN user ───────────────────────────────────────────────────────
  if (role === null) {
    const isOtpAttempt = /^\d{6}$/.test(text);

    if (isOtpAttempt) {
      // Try to validate the OTP
      const valid = await validateOtp(userId, text, env.A3LIX_KV);

      if (valid) {
        // Find who approved — for OTP flow: the owner is the approver
        const completed = await completeOnboarding(
          userId,
          displayName,
          config.bot.ownerChatId,
          env.A3LIX_KV,
        );

        if (completed) {
          await sendTelegramMessage({
            chatId,
            text: replyWelcomeEditor(displayName),
            botToken: env.TELEGRAM_BOT_TOKEN,
          }).catch(() => undefined);
        } else {
          // Validation window expired between validateOtp and completeOnboarding
          await sendTelegramMessage({
            chatId,
            text: replyOtpInvalid(),
            botToken: env.TELEGRAM_BOT_TOKEN,
          }).catch(() => undefined);
        }
      } else {
        await sendTelegramMessage({
          chatId,
          text: replyOtpInvalid(),
          botToken: env.TELEGRAM_BOT_TOKEN,
        }).catch(() => undefined);
      }

      return;
    }

    // Not an OTP — initiate access request (idempotent)
    await initiateAccessRequest(userId, displayName, text, env.A3LIX_KV);

    // Notify the unknown user
    await sendTelegramMessage({
      chatId,
      text: replyUnknownUser(displayName),
      botToken: env.TELEGRAM_BOT_TOKEN,
    }).catch(() => undefined);

    // Notify the owner
    await sendTelegramMessage({
      chatId: config.bot.ownerChatId,
      text: replyOwnerApprovalNeeded(displayName, userId, text.slice(0, 200)),
      botToken: env.TELEGRAM_BOT_TOKEN,
    }).catch(() => undefined);

    return;
  }

  // ── 3. OWNER handling "yes" ───────────────────────────────────────────────
  if (role === 'owner' && text.toLowerCase() === 'yes') {
    // Priority: site change approvals first, then access requests.
    const pendingApprovals = await listPendingApprovals(env.A3LIX_KV);

    if (pendingApprovals.length > 0) {
      // Approve the most recent pending approval (last in the sorted list).
      const approval = pendingApprovals[pendingApprovals.length - 1];

      if (!approval) {
        await sendTelegramMessage({
          chatId,
          text: replyNoPendingApproval(),
          botToken: env.TELEGRAM_BOT_TOKEN,
        }).catch(() => undefined);
        return;
      }

      // Do the heavy work asynchronously.
      ctx.waitUntil((async () => {
        try {
          const githubConfig = buildGitHubConfig(
            env.GITHUB_TOKEN,
            config.project.repo,
            config.project.branch,
          );

          const mergeResult = await approveAndMerge({
            githubConfig,
            branchName: approval.branchName,
            summary: approval.summary,
            userId,
          });

          await deletePendingApproval(approval.branchName, env.A3LIX_KV);

          const mergedText = replyMerged({
            summary: approval.summary,
            commitSha: mergeResult.commitSha,
          });

          // Notify the editor who requested the change.
          await sendTelegramMessage({
            chatId: approval.requestedByUserId,
            text: mergedText,
            botToken: env.TELEGRAM_BOT_TOKEN,
          }).catch(() => undefined);

          // Confirm to the owner too.
          await sendTelegramMessage({
            chatId,
            text: mergedText,
            botToken: env.TELEGRAM_BOT_TOKEN,
          }).catch(() => undefined);
        } catch (error: unknown) {
          if (error instanceof GitHubError) {
            await sendTelegramMessage({
              chatId,
              text: replyGitHubError(error.endpoint),
              botToken: env.TELEGRAM_BOT_TOKEN,
            }).catch(() => undefined);
          } else {
            await sendTelegramMessage({
              chatId,
              text: replyInternalError(),
              botToken: env.TELEGRAM_BOT_TOKEN,
            }).catch(() => undefined);
          }
        }
      })());

      return;
    }

    // No pending site approvals — check for pending access requests.
    const accessListResult = await env.A3LIX_KV.list({ prefix: 'access:request:' });

    if (accessListResult.keys.length > 0) {
      // Find the most recent access request — list returns keys in order.
      const mostRecentKey = accessListResult.keys[accessListResult.keys.length - 1];

      if (!mostRecentKey) {
        await sendTelegramMessage({
          chatId,
          text: replyNoPendingApproval(),
          botToken: env.TELEGRAM_BOT_TOKEN,
        }).catch(() => undefined);
        return;
      }

      const rawRequest = await env.A3LIX_KV.get(mostRecentKey.name);
      if (rawRequest === null) {
        await sendTelegramMessage({
          chatId,
          text: replyNoPendingApproval(),
          botToken: env.TELEGRAM_BOT_TOKEN,
        }).catch(() => undefined);
        return;
      }

      let accessRequest: { userId: string; displayName?: string } | null = null;
      try {
        const parsed: unknown = JSON.parse(rawRequest);
        if (typeof parsed === 'object' && parsed !== null) {
          const p = parsed as Record<string, unknown>;
          if (typeof p['userId'] === 'string') {
            accessRequest = {
              userId: p['userId'],
              ...(typeof p['displayName'] === 'string'
                ? { displayName: p['displayName'] }
                : {}),
            };
          }
        }
      } catch {
        // Malformed record — ignore
      }

      if (!accessRequest) {
        await sendTelegramMessage({
          chatId,
          text: replyNoPendingApproval(),
          botToken: env.TELEGRAM_BOT_TOKEN,
        }).catch(() => undefined);
        return;
      }

      const requesterUserId = accessRequest.userId;

      // Generate OTP and send to the requester.
      // In Telegram private chats, userId === chatId.
      ctx.waitUntil((async () => {
        try {
          const otpRequest = await generateOtp(requesterUserId, env.A3LIX_KV);

          await sendTelegramMessage({
            chatId: requesterUserId,
            text: replyOtpIssued(otpRequest.otp),
            botToken: env.TELEGRAM_BOT_TOKEN,
          });
        } catch (error: unknown) {
          await sendTelegramMessage({
            chatId,
            text: replyInternalError(),
            botToken: env.TELEGRAM_BOT_TOKEN,
          }).catch(() => undefined);
        }
      })());

      return;
    }

    // Nothing pending at all.
    await sendTelegramMessage({
      chatId,
      text: replyNoPendingApproval(),
      botToken: env.TELEGRAM_BOT_TOKEN,
    }).catch(() => undefined);

    return;
  }

  // ── 4. VIEWER ─────────────────────────────────────────────────────────────
  if (role === 'viewer') {
    const isStatusQuery =
      /status|what'?s live|deployed|changes/i.test(text);

    if (isStatusQuery) {
      const pendingApprovals = await listPendingApprovals(env.A3LIX_KV);
      const lastDeployRaw = await env.A3LIX_KV.get('last_deploy');
      const lastDeployedAt = lastDeployRaw ?? undefined;

      await sendTelegramMessage({
        chatId,
        text: replyStatusCheck({
          pendingCount: pendingApprovals.length,
          ...(lastDeployedAt !== undefined ? { lastDeployedAt } : {}),
          pagesProjectName: config.cloudflare.pagesProjectName,
        }),
        botToken: env.TELEGRAM_BOT_TOKEN,
      }).catch(() => undefined);

      return;
    }

    await sendTelegramMessage({
      chatId,
      text: replyViewerCannotEdit(),
      botToken: env.TELEGRAM_BOT_TOKEN,
    }).catch(() => undefined);

    return;
  }

  // ── 5. EDITOR or OWNER making a change request ────────────────────────────
  // (Owner falls through here when text is not "yes")

  // Status check for editor/owner.
  if (/status|what'?s live|deployed|changes/i.test(text)) {
    const pendingApprovals = await listPendingApprovals(env.A3LIX_KV);
    const lastDeployRaw = await env.A3LIX_KV.get('last_deploy');
    const lastDeployedAt = lastDeployRaw ?? undefined;

    await sendTelegramMessage({
      chatId,
      text: replyStatusCheck({
        pendingCount: pendingApprovals.length,
        ...(lastDeployedAt !== undefined ? { lastDeployedAt } : {}),
        pagesProjectName: config.cloudflare.pagesProjectName,
      }),
      botToken: env.TELEGRAM_BOT_TOKEN,
    }).catch(() => undefined);

    return;
  }

  // Rate limit pre-check (fast, before spinning up AI).
  const rateResult = await checkRateLimit(
    userId,
    env.A3LIX_KV,
    config.limits.changesPerUserPerDay,
  );

  if (!rateResult.allowed) {
    await sendTelegramMessage({
      chatId,
      text: replyRateLimited(config.limits.changesPerUserPerDay),
      botToken: env.TELEGRAM_BOT_TOKEN,
    }).catch(() => undefined);
    return;
  }

  // Acknowledge immediately — AI + GitHub work runs in the background.
  await sendTelegramMessage({
    chatId,
    text: replyParsing(),
    botToken: env.TELEGRAM_BOT_TOKEN,
  }).catch(() => undefined);

  ctx.waitUntil(
    handleChangeRequest(text, userId, chatId, displayName, config, env),
  );
}

// ---------------------------------------------------------------------------
// Telegram webhook handler
// ---------------------------------------------------------------------------

/**
 * Handles `POST /telegram` requests.
 *
 * 1. Verifies the Telegram webhook secret token.
 * 2. Parses the request body as a {@link TelegramUpdate}.
 * 3. Extracts message fields and dispatches to {@link routeMessage}.
 * 4. Always returns HTTP 200 to Telegram within ~3 seconds.
 *
 * @param request - The incoming HTTP request.
 * @param env     - Worker {@link Env} bindings.
 * @param ctx     - Worker execution context.
 * @returns An HTTP 200 response to acknowledge the webhook.
 */
async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ── 1. Verify webhook secret ──────────────────────────────────────────────
  if (!verifyTelegramWebhook(request, env.TELEGRAM_SECRET_TOKEN)) {
    return new Response(null, { status: 401 });
  }

  // ── 2. Parse request body ─────────────────────────────────────────────────
  let update: TelegramUpdate;
  try {
    const body: unknown = await request.json();
    update = body as TelegramUpdate;
  } catch {
    return new Response(null, { status: 400 });
  }

  // ── 3. Extract message ────────────────────────────────────────────────────
  const message = update.message;
  if (!message) {
    // Telegram sends other update types (edited_message, channel_post, etc.)
    // — acknowledge and ignore.
    return new Response('OK', { status: 200 });
  }

  // ── 4. Extract message fields ─────────────────────────────────────────────
  if (!message.from) {
    // Anonymous messages (e.g. channel posts forwarded without user info).
    return new Response('OK', { status: 200 });
  }

  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text?.trim() ?? '';
  const displayName = message.from.username ?? message.from.first_name;

  // ── 5. Load config ────────────────────────────────────────────────────────
  let config: AgentConfig;
  try {
    config = await loadConfig(env.A3LIX_KV);
  } catch (error: unknown) {
    await sendTelegramMessage({
      chatId,
      text: replyInternalError(),
      botToken: env.TELEGRAM_BOT_TOKEN,
    }).catch(() => undefined);
    return new Response('OK', { status: 200 });
  }

  // ── 6. Route message (fire-and-forget for heavy work) ────────────────────
  // routeMessage itself sends replyParsing + calls ctx.waitUntil internally.
  // We call it here; any await inside it that isn't within waitUntil resolves
  // before we return 200.
  await routeMessage(text, userId, chatId, displayName, config, env, ctx);

  // ── 7. Always return 200 to Telegram ─────────────────────────────────────
  return new Response('OK', { status: 200 });
}

// ---------------------------------------------------------------------------
// Email webhook stub
// ---------------------------------------------------------------------------

/**
 * Handles `POST /email` requests.
 *
 * This is a placeholder for the v1.1 Email Workers integration.
 *
 * @param _request - The incoming HTTP request (unused).
 * @param _env     - Worker {@link Env} bindings (unused).
 * @returns HTTP 200 with a plain-text note.
 */
async function handleEmailWebhook(
  _request: Request,
  _env: Env,
): Promise<Response> {
  // TODO: Email Workers handler coming in v1.1
  // See docs/SECURITY.md for the planned implementation
  return new Response('Email handler not yet implemented', { status: 200 });
}

// ---------------------------------------------------------------------------
// Worker default export
// ---------------------------------------------------------------------------

/**
 * A3lix Cloudflare Worker default export.
 *
 * Routes all HTTP requests to the appropriate handler:
 *   - `POST /telegram` → Telegram bot webhook
 *   - `POST /email`    → Email webhook stub
 *   - `GET  /health`   → Health check
 *   - All others       → 404
 */
export default {
  /**
   * The main Worker `fetch` handler. Called for every incoming HTTP request.
   *
   * @param request - The incoming HTTP request.
   * @param env     - The bound {@link Env} (bindings + secrets + vars).
   * @param ctx     - The execution context (provides `waitUntil`).
   * @returns An HTTP `Response`.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    // ── POST /telegram ───────────────────────────────────────────────────────
    if (method === 'POST' && pathname === '/telegram') {
      return handleTelegramWebhook(request, env, ctx);
    }

    // ── POST /email ──────────────────────────────────────────────────────────
    if (method === 'POST' && pathname === '/email') {
      return handleEmailWebhook(request, env);
    }

    // ── GET /health ──────────────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.1.0',
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
