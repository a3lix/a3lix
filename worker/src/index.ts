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
 *   POST /github    →  handleGitHubWebhook
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
  auditLog,
  type FileChange,
} from './guardrails';

import {
  getUserRole,
  initiateAccessRequest,
  generateOtp,
  validateOtp,
  completeOnboarding,
} from './roles';

import {
  parse,
  type AiConfig,
  type ParseResult,
} from './parser';

import {
  type GitHubConfig,
  type GitHubFileChange,
  getPendingApproval,
  storePendingApproval,
  deletePendingApproval,
  listPendingApprovals,
  type PendingApproval,
  GitHubError,
} from './github';

import {
  deployPreview,
  approveAndMerge,
  checkPreviewStatus,
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
  replyPreviewBuilding,
  replyPreviewQueued,
  replyPreviewStillBuilding,
  replyPreviewFailed,
  replyUnknownIntent,
  replyNeedsClarification,
  replyPreviewReady,
  replyApprovalPending,
  replyMerged,
  replyNoPendingApproval,
  replyViewerCannotEdit,
  replyRateLimited,
  replyGuardrailBlocked,
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
  /** Shared secret for GitHub webhook signature verification (HMAC SHA-256). */
  GITHUB_WEBHOOK_SECRET?: string;
  /** API key for non-Workers-AI providers (openai, claude, grok, groq, gemini). */
  AI_API_KEY: string;
  /** Optional Cloudflare account ID for Pages deployment polling. */
  CF_ACCOUNT_ID?: string;
  /** Optional Cloudflare API token for Pages deployment polling. */
  CF_API_TOKEN?: string;

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

type GitHubWebhookOutcome = 'success' | 'failure' | 'unknown';

interface GitHubWebhookResolution {
  branchName: string;
  outcome: GitHubWebhookOutcome;
}

interface PendingPreviewNotification {
  branchName: string;
  summary: string;
  requestedByUserId: string;
  requesterChatId: string;
  ownerChatId: string;
  pagesProjectName: string;
  estimatedSeconds: number;
  createdAt: string;
  nextCheckAt: string;
  attempts: number;
  delayNoticesSent: number;
  lastKnownPreviewUrl: string;
}

const PREVIEW_NOTIFICATION_KEY_PREFIX = 'preview:notify:';
const PREVIEW_NOTIFICATION_LOCK_PREFIX = 'preview:notify:lock:';
const PREVIEW_NOTIFICATION_TTL_SECONDS = 86_400;

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

function isPendingPreviewNotification(value: unknown): value is PendingPreviewNotification {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['branchName'] === 'string' &&
    typeof v['summary'] === 'string' &&
    typeof v['requestedByUserId'] === 'string' &&
    typeof v['requesterChatId'] === 'string' &&
    typeof v['ownerChatId'] === 'string' &&
    typeof v['pagesProjectName'] === 'string' &&
    typeof v['estimatedSeconds'] === 'number' &&
    typeof v['createdAt'] === 'string' &&
    typeof v['nextCheckAt'] === 'string' &&
    typeof v['attempts'] === 'number' &&
    typeof v['delayNoticesSent'] === 'number' &&
    typeof v['lastKnownPreviewUrl'] === 'string'
  );
}

function previewNotificationKey(branchName: string): string {
  return `${PREVIEW_NOTIFICATION_KEY_PREFIX}${branchName}`;
}

function previewNotificationLockKey(branchName: string): string {
  return `${PREVIEW_NOTIFICATION_LOCK_PREFIX}${branchName}`;
}

function envCfBindings(env: Env): { CF_ACCOUNT_ID?: string; CF_API_TOKEN?: string } {
  return {
    ...(env.CF_ACCOUNT_ID !== undefined ? { CF_ACCOUNT_ID: env.CF_ACCOUNT_ID } : {}),
    ...(env.CF_API_TOKEN !== undefined ? { CF_API_TOKEN: env.CF_API_TOKEN } : {}),
  };
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function isPreviewBranchName(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('preview-');
}

function extractGitHubWebhookResolution(
  eventName: string,
  payload: unknown,
): GitHubWebhookResolution | null {
  const root = safeRecord(payload);
  if (!root) return null;

  if (eventName === 'check_run') {
    if (root['action'] !== 'completed') return null;
    const checkRun = safeRecord(root['check_run']);
    const checkSuite = safeRecord(checkRun?.['check_suite']);
    const branchName = checkSuite?.['head_branch'];
    if (!isPreviewBranchName(branchName)) return null;

    const conclusion = checkRun?.['conclusion'];
    if (conclusion === 'success') return { branchName, outcome: 'success' };
    if (
      conclusion === 'failure' ||
      conclusion === 'timed_out' ||
      conclusion === 'cancelled' ||
      conclusion === 'action_required' ||
      conclusion === 'stale'
    ) {
      return { branchName, outcome: 'failure' };
    }
    return { branchName, outcome: 'unknown' };
  }

  if (eventName === 'check_suite') {
    if (root['action'] !== 'completed') return null;
    const checkSuite = safeRecord(root['check_suite']);
    const branchName = checkSuite?.['head_branch'];
    if (!isPreviewBranchName(branchName)) return null;

    const conclusion = checkSuite?.['conclusion'];
    if (conclusion === 'success') return { branchName, outcome: 'success' };
    if (
      conclusion === 'failure' ||
      conclusion === 'timed_out' ||
      conclusion === 'cancelled' ||
      conclusion === 'action_required' ||
      conclusion === 'stale'
    ) {
      return { branchName, outcome: 'failure' };
    }
    return { branchName, outcome: 'unknown' };
  }

  if (eventName === 'status') {
    const state = root['state'];
    if (state !== 'success' && state !== 'failure' && state !== 'error') return null;

    const branches = Array.isArray(root['branches']) ? root['branches'] : [];
    for (const b of branches) {
      const branch = safeRecord(b)?.['name'];
      if (!isPreviewBranchName(branch)) continue;
      return {
        branchName: branch,
        outcome: state === 'success' ? 'success' : 'failure',
      };
    }
    return null;
  }

  if (eventName === 'deployment_status') {
    const deployment = safeRecord(root['deployment']);
    const status = safeRecord(root['deployment_status']);
    const branchName = deployment?.['ref'];
    if (!isPreviewBranchName(branchName)) return null;

    const state = status?.['state'];
    if (state === 'success') return { branchName, outcome: 'success' };
    if (
      state === 'failure' ||
      state === 'error' ||
      state === 'inactive'
    ) {
      return { branchName, outcome: 'failure' };
    }
    return { branchName, outcome: 'unknown' };
  }

  return null;
}

function timingSafeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return mismatch === 0;
}

async function verifyGitHubWebhook(
  request: Request,
  bodyText: string,
  secret: string,
): Promise<boolean> {
  const signatureHeader = request.headers.get('X-Hub-Signature-256');
  if (signatureHeader === null) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const providedHex = signatureHeader.slice('sha256='.length).toLowerCase();

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(bodyText),
  );

  const expectedHex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeHexEquals(providedHex, expectedHex);
}

async function storePendingPreviewNotification(
  notification: PendingPreviewNotification,
  kv: KVNamespace,
): Promise<void> {
  await kv.put(
    previewNotificationKey(notification.branchName),
    JSON.stringify(notification),
    { expirationTtl: PREVIEW_NOTIFICATION_TTL_SECONDS },
  );
}

async function getPendingPreviewNotification(
  branchName: string,
  kv: KVNamespace,
): Promise<PendingPreviewNotification | null> {
  const raw = await kv.get(previewNotificationKey(branchName));
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    return isPendingPreviewNotification(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function deletePendingPreviewNotification(branchName: string, kv: KVNamespace): Promise<void> {
  await kv.delete(previewNotificationKey(branchName));
}

async function listPendingPreviewNotificationBranches(kv: KVNamespace): Promise<string[]> {
  const list = await kv.list({ prefix: PREVIEW_NOTIFICATION_KEY_PREFIX });
  return list.keys
    .map((k) =>
      k.name.startsWith(PREVIEW_NOTIFICATION_KEY_PREFIX)
        ? k.name.slice(PREVIEW_NOTIFICATION_KEY_PREFIX.length)
        : null,
    )
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

async function processPendingPreviewNotification(
  branchName: string,
  env: Env,
  options?: { forceCheck?: boolean },
): Promise<void> {
  const forceCheck = options?.forceCheck === true;
  const lockKey = previewNotificationLockKey(branchName);
  const existingLock = await env.A3LIX_KV.get(lockKey);
  if (existingLock !== null) return;

  await env.A3LIX_KV.put(lockKey, '1', { expirationTtl: 55 });

  const notification = await getPendingPreviewNotification(branchName, env.A3LIX_KV);
  if (!notification) {
    return;
  }

  const nowMs = Date.now();
  const nextCheckMs = Date.parse(notification.nextCheckAt);
  if (!forceCheck && Number.isFinite(nextCheckMs) && nextCheckMs > nowMs) {
    return;
  }

  const approval = await getPendingApproval(notification.branchName, env.A3LIX_KV);
  if (!approval) {
    await deletePendingPreviewNotification(notification.branchName, env.A3LIX_KV);
    return;
  }

  const status = await checkPreviewStatus({
    pagesProjectName: notification.pagesProjectName,
    branchName: notification.branchName,
    env: envCfBindings(env),
  });

  if (status.state === 'ready') {
    await sendTelegramMessage({
      chatId: notification.requesterChatId,
      text: replyPreviewReady({
        summary: notification.summary,
        previewUrl: status.previewUrl,
        estimatedSeconds: notification.estimatedSeconds,
        branchName: notification.branchName,
      }),
      botToken: env.TELEGRAM_BOT_TOKEN,
    });

    if (notification.requestedByUserId !== notification.ownerChatId) {
      await sendTelegramMessage({
        chatId: notification.ownerChatId,
        text: replyApprovalPending(status.previewUrl),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });
    }

    await deletePendingPreviewNotification(notification.branchName, env.A3LIX_KV);
    return;
  }

  if (status.state === 'failed') {
    const failureText = replyPreviewFailed({
      summary: notification.summary,
      branchName: notification.branchName,
      ...(status.failureReason !== undefined ? { reason: status.failureReason } : {}),
    });

    await sendTelegramMessage({
      chatId: notification.requesterChatId,
      text: failureText,
      botToken: env.TELEGRAM_BOT_TOKEN,
    });

    if (notification.requestedByUserId !== notification.ownerChatId) {
      await sendTelegramMessage({
        chatId: notification.ownerChatId,
        text: failureText,
        botToken: env.TELEGRAM_BOT_TOKEN,
      });
    }

    await deletePendingApproval(notification.branchName, env.A3LIX_KV);
    await deletePendingPreviewNotification(notification.branchName, env.A3LIX_KV);
    return;
  }

  if (forceCheck) {
    const updated: PendingPreviewNotification = {
      ...notification,
      nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
      lastKnownPreviewUrl: status.previewUrl,
    };

    await storePendingPreviewNotification(updated, env.A3LIX_KV);
    return;
  }

  const attempts = notification.attempts + 1;
  const shouldSendDelayNotice =
    (attempts === 10 || attempts === 30) && notification.delayNoticesSent < 2;

  if (shouldSendDelayNotice) {
    await sendTelegramMessage({
      chatId: notification.requesterChatId,
      text: replyPreviewStillBuilding({
        branchName: notification.branchName,
        minutesWaiting: Math.ceil((Date.now() - Date.parse(notification.createdAt)) / 60_000),
      }),
      botToken: env.TELEGRAM_BOT_TOKEN,
    });
  }

  const nextDelaySeconds = attempts < 10 ? 60 : attempts < 30 ? 120 : 300;
  const updated: PendingPreviewNotification = {
    ...notification,
    attempts,
    delayNoticesSent: shouldSendDelayNotice
      ? notification.delayNoticesSent + 1
      : notification.delayNoticesSent,
    nextCheckAt: new Date(Date.now() + nextDelaySeconds * 1000).toISOString(),
    lastKnownPreviewUrl: status.previewUrl,
  };

  await storePendingPreviewNotification(updated, env.A3LIX_KV);
}

async function runPreviewNotificationPoller(env: Env, ctx: ExecutionContext): Promise<void> {
  const branches = await listPendingPreviewNotificationBranches(env.A3LIX_KV);
  for (const branchName of branches) {
    ctx.waitUntil(
      processPendingPreviewNotification(branchName, env).catch((error: unknown) => {
        console.error('[a3lix] preview notification poll error:', error);
      }),
    );
  }
}

async function handleGitHubWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return new Response(null, { status: 503 });
  }

  const eventName = request.headers.get('X-GitHub-Event');
  if (!eventName) {
    return new Response(null, { status: 400 });
  }

  let bodyText = '';
  try {
    bodyText = await request.text();
  } catch {
    return new Response(null, { status: 400 });
  }

  const valid = await verifyGitHubWebhook(request, bodyText, env.GITHUB_WEBHOOK_SECRET);
  if (!valid) {
    return new Response(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return new Response(null, { status: 400 });
  }

  const resolution = extractGitHubWebhookResolution(eventName, payload);
  if (!resolution) {
    return new Response('OK', { status: 200 });
  }

  ctx.waitUntil(
    processPendingPreviewNotification(resolution.branchName, env, { forceCheck: true }).catch(
      (error: unknown) => {
        console.error('[a3lix] github webhook preview processing failed:', error);
      },
    ),
  );

  return new Response('OK', { status: 200 });
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

/**
 * Deduplicates Telegram webhook deliveries by `update_id`.
 *
 * Telegram can retry the same update if the webhook ack is delayed; without
 * this KV marker, one user message can trigger multiple preview deployments.
 *
 * @param updateId - Telegram `update_id`.
 * @param kv       - KV namespace used for idempotency markers.
 * @returns `true` when this update should be processed, `false` when duplicate.
 */
async function claimTelegramUpdate(
  updateId: number,
  kv: KVNamespace,
): Promise<boolean> {
  const key = `telegram:update:${updateId}`;
  const existing = await kv.get(key);
  if (existing !== null) return false;

  await kv.put(key, '1', { expirationTtl: 600 });
  return true;
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
  preloadedFileTree?: string,
  preloadedFileContents?: Record<string, string>,
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

    // ── 2. Parse (using pre-fetched file tree + contents from routeMessage) ─────
    const parseResult: ParseResult = await parse({
      message: text,
      framework: config.project.framework,
      aiConfig,
      aiBinding: env.AI,
      ...(preloadedFileTree !== undefined ? { fileTree: preloadedFileTree } : {}),
      ...(preloadedFileContents !== undefined && Object.keys(preloadedFileContents).length > 0 ? { fileContents: preloadedFileContents } : {}),
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

    // ── 4. Map ParseResult.changes → FileChange[], applying line changes ─────────
    // When the AI returns lineChanges (for surgical edits to existing files),
    // apply them against the preloaded file content to produce the final content.
    const fileChanges: FileChange[] = changes.map((c) => {
      let resolvedContent = c.content ?? '';

      if (c.lineChanges && c.lineChanges.length > 0) {
        const existingContent = preloadedFileContents?.[c.path];
        if (existingContent) {
          // Apply line changes in reverse order (so line numbers stay valid)
          const lines = existingContent.split('\n');
          const sorted = [...c.lineChanges].sort((a, b) => b.startLine - a.startLine);
          for (const lc of sorted) {
            const start = Math.max(0, lc.startLine - 1); // 0-indexed
            const end = Math.min(lines.length, lc.endLine); // exclusive end
            lines.splice(start, end - start, ...lc.newLines);
          }
          resolvedContent = lines.join('\n');
        }
      }

      return {
        path: c.path,
        content: resolvedContent,
        operation: c.operation as 'create' | 'update' | 'delete',
      };
    });

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

    // ── 5. Run non-rate guardrails (rate limit is already enforced in routeMessage) ──
    const pathResult = checkAllowedPaths(fileChanges, config.paths.allowed);
    if (!pathResult.allowed) {
      await sendTelegramMessage({
        chatId,
        text: replyGuardrailBlocked(pathResult.reason ?? 'unknown'),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });

      await auditLog({
          userId,
          action: 'change_request',
          paths: fileChanges.map((c) => c.path),
          outcome: 'blocked',
          ...(pathResult.reason !== undefined ? { reason: pathResult.reason } : {}),
          kv: env.A3LIX_KV,
        });
      return;
    }

    const keywordResult = checkDestructiveKeywords(fileChanges);
    if (!keywordResult.allowed) {
      await sendTelegramMessage({
        chatId,
        text: replyGuardrailBlocked(keywordResult.reason ?? 'unknown'),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });

      await auditLog({
          userId,
          action: 'change_request',
          paths: fileChanges.map((c) => c.path),
          outcome: 'blocked',
          ...(keywordResult.reason !== undefined ? { reason: keywordResult.reason } : {}),
          kv: env.A3LIX_KV,
        });
      return;
    }

    const opResult = checkOperationAllowed(fileChanges);
    if (!opResult.allowed) {
      await sendTelegramMessage({
        chatId,
        text: replyGuardrailBlocked(opResult.reason ?? 'unknown'),
        botToken: env.TELEGRAM_BOT_TOKEN,
      });

      await auditLog({
          userId,
          action: 'change_request',
          paths: fileChanges.map((c) => c.path),
          outcome: 'blocked',
          ...(opResult.reason !== undefined ? { reason: opResult.reason } : {}),
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
    await sendTelegramMessage({
      chatId,
      text: replyPreviewBuilding(),
      botToken: env.TELEGRAM_BOT_TOKEN,
    });

    const deployResult = await deployPreview({
      githubConfig,
      deployConfig,
      userId,
      changes: githubChanges,
      summary,
      env: envCfBindings(env),
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

    const pendingPreviewNotification: PendingPreviewNotification = {
      branchName: deployResult.branchName,
      summary,
      requestedByUserId: userId,
      requesterChatId: String(chatId),
      ownerChatId: config.bot.ownerChatId,
      pagesProjectName: config.cloudflare.pagesProjectName,
      estimatedSeconds: deployResult.estimatedBuildSeconds,
      createdAt: now.toISOString(),
      nextCheckAt: new Date(now.getTime() + 60_000).toISOString(),
      attempts: 0,
      delayNoticesSent: 0,
      lastKnownPreviewUrl: deployResult.previewUrl,
    };

    await storePendingPreviewNotification(pendingPreviewNotification, env.A3LIX_KV);

    // ── 9. Write last_deploy timestamp ────────────────────────────────────────
    await env.A3LIX_KV.put('last_deploy', now.toISOString());

    // ── 10. Notify requesting user ────────────────────────────────────────────
    await sendTelegramMessage({
      chatId,
      text: replyPreviewQueued({
        branchName: deployResult.branchName,
        estimatedSeconds: deployResult.estimatedBuildSeconds,
      }),
      botToken: env.TELEGRAM_BOT_TOKEN,
    });

    // ── 11. Audit log — allowed ───────────────────────────────────────────────
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
 */
async function routeMessage(
  text: string,
  userId: string,
  chatId: number,
  displayName: string | undefined,
  config: AgentConfig,
  env: Env,
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

      // Do the heavy work synchronously (no waitUntil — avoids 30s limit).
      try {
        const githubConfig = buildGitHubConfig(
          env.GITHUB_TOKEN,
          config.project.repo,
          config.project.branch,
        );

        // Atomic lock: try to claim this merge by writing a lock key.
        // If the key already exists (another YES is processing), skip silently.
        const lockKey = `merge-lock:${approval.branchName}`;
        const existingLock = await env.A3LIX_KV.get(lockKey);
        if (existingLock !== null) {
          // Already being processed — ignore this duplicate YES.
          return;
        }
        // Claim the lock (expires in 60 seconds as safety net).
        await env.A3LIX_KV.put(lockKey, '1', { expirationTtl: 60 });

        // Now delete the pending approval and proceed.
        await deletePendingApproval(approval.branchName, env.A3LIX_KV);

        const mergeResult = await approveAndMerge({
          githubConfig,
          branchName: approval.branchName,
          summary: approval.summary,
          userId,
        });

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

      // Generate OTP and send to the requester synchronously.
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

  // Pre-fetch repo file tree + likely file contents BEFORE waitUntil
  // (fetch calls here don't count against the 30s waitUntil CPU budget).
  let preloadedFileTree: string | undefined;
  let preloadedFileContents: Record<string, string> | undefined;
  try {
    const ghHeaders = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'A3lix-Bot/0.1',
    };
    const treeUrl = `https://api.github.com/repos/${config.project.repo}/git/trees/${config.project.branch}?recursive=1`;
    const treeResp = await fetch(treeUrl, { headers: ghHeaders });
    if (treeResp.ok) {
      const treeData = await treeResp.json() as { tree?: Array<{ path: string; type: string }> };
      const allowedExts = /\.(tsx?|jsx?|astro|mdx?|json|css|html)$/;
      const allFiles = (treeData.tree ?? [])
        .filter(f => f.type === 'blob' && allowedExts.test(f.path) && !f.path.includes('node_modules') && !f.path.includes('.next') && !f.path.startsWith('.'))
        .map(f => f.path);
      preloadedFileTree = allFiles.slice(0, 80).join('\n');

      // Identify likely target files from message keywords
      const msgLower = text.toLowerCase();
      const keywords = [
        { words: ['hero', 'banner', 'headline', 'heading'], pattern: /hero/i },
        { words: ['footer', 'copyright'], pattern: /footer/i },
        { words: ['header', 'nav', 'navigation', 'menu'], pattern: /header|nav/i },
        { words: ['color', 'colour', 'brand', 'theme', 'tailwind'], pattern: /tailwind|globals?\.css/i },
        { words: ['home', 'index', 'main page'], pattern: /page|index/i },
      ];
      const targetFiles: string[] = [];
      for (const { words, pattern } of keywords) {
        if (words.some(w => msgLower.includes(w))) {
          allFiles.filter(f => pattern.test(f) && !f.includes('/ui/')).forEach(f => {
            if (!targetFiles.includes(f)) targetFiles.push(f);
          });
        }
      }
      if (targetFiles.length > 0) {
        preloadedFileContents = {};
        await Promise.all(targetFiles.slice(0, 2).map(async (filePath) => {
          try {
            const contentUrl = `https://api.github.com/repos/${config.project.repo}/contents/${filePath}?ref=${config.project.branch}`;
            const contentResp = await fetch(contentUrl, { headers: ghHeaders });
            if (contentResp.ok) {
              const contentData = await contentResp.json() as { content?: string; encoding?: string };
              if (contentData.encoding === 'base64' && contentData.content && preloadedFileContents) {
                preloadedFileContents[filePath] = atob(contentData.content.replace(/\n/g, ''));
              }
            }
          } catch { /* non-fatal */ }
        }));
      }
    }
  } catch { /* non-fatal */ }

  // Acknowledge — then do all work synchronously (no waitUntil — avoids 30s limit).
  // The HTTP 200 to Telegram is returned after handleChangeRequest completes.
  // Telegram waits up to 60 seconds, and the work is 100% I/O-bound (no CPU limit applies).
  await sendTelegramMessage({
    chatId,
    text: replyParsing(),
    botToken: env.TELEGRAM_BOT_TOKEN,
  }).catch(() => undefined);

  await handleChangeRequest(text, userId, chatId, displayName, config, env, preloadedFileTree, preloadedFileContents);
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

  // ── 5. Idempotency guard (Telegram retries can deliver the same update) ──
  if (typeof update.update_id === 'number') {
    const shouldProcess = await claimTelegramUpdate(update.update_id, env.A3LIX_KV);
    if (!shouldProcess) {
      return new Response('OK', { status: 200 });
    }
  }

  // ── 6. Load config ────────────────────────────────────────────────────────
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

  // ── 7. Route message asynchronously and ACK Telegram immediately ──────────
  ctx.waitUntil(
    routeMessage(text, userId, chatId, displayName, config, env).catch((error: unknown) => {
      console.error('[a3lix] routeMessage failed:', error);
    }),
  );

  // ── 8. Always return 200 to Telegram quickly (prevents retries) ───────────
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
 *   - `POST /github`   → GitHub webhook for event-driven preview completion
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

    // ── POST /github ─────────────────────────────────────────────────────────
    if (method === 'POST' && pathname === '/github') {
      return handleGitHubWebhook(request, env, ctx);
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

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await runPreviewNotificationPoller(env, ctx);
  },
} satisfies ExportedHandler<Env>;
