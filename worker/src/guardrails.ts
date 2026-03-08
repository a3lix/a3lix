/**
 * @module guardrails
 *
 * The safety brain of A3lix. This module is the LAST line of defense before any
 * AI-generated content is written to a client's GitHub repository.
 *
 * Execution order (enforced by `runAllGuardrails`):
 *   1. Rate limit  — prevents a single user from flooding the system
 *   2. Allowed paths — ensures writes stay inside the declared safe zone
 *   3. Destructive keywords — detects secrets, credentials, and dangerous code
 *   4. Operation check — blocks file-delete operations from the agent
 *
 * All checks are PARANOID by design: when in doubt, block.
 * No exceptions propagate to callers; failures are silently absorbed by
 * `auditLog` so that audit recording never disrupts the main request flow.
 *
 * @see agent.json.example for the GuardrailConfig shape used at runtime.
 */

// ---------------------------------------------------------------------------
// Type imports
// ---------------------------------------------------------------------------
// KVNamespace is provided by the Cloudflare Workers runtime type definitions.
// We reference it via the global ambient type so this file has zero local deps.
/// <reference types="@cloudflare/workers-types" />

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

/**
 * The result returned by every guardrail check.
 * Consumers MUST check `allowed` before proceeding.
 */
export interface GuardrailResult {
  /** Whether the operation is permitted to continue. */
  allowed: boolean;
  /**
   * Human-readable explanation shown to the Telegram user when blocked.
   * Should be informative but MUST NOT echo secrets or raw pattern matches.
   */
  reason?: string;
  /**
   * Coarse risk classification for logging and alerting:
   * - `safe`     – all checks passed
   * - `low`      – minor concern, still allowed (reserved for future use)
   * - `medium`   – potential issue, allowed with caution (reserved)
   * - `high`     – blocked; rate limit exceeded or disallowed path/operation
   * - `critical` – blocked; potential secret exfiltration or path traversal
   */
  riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
}

/**
 * A single file mutation the AI agent wants to apply to the repository.
 */
export interface FileChange {
  /** Repo-relative file path, e.g. `src/pages/index.astro`. */
  path: string;
  /** Full UTF-8 text content for `create` / `update`; ignored for `delete`. */
  content: string;
  /** The type of mutation requested. */
  operation: 'create' | 'update' | 'delete';
}

/**
 * Runtime configuration sourced from `agent.json` and injected by the Worker
 * before calling any guardrail function.
 */
export interface GuardrailConfig {
  /**
   * Absolute-root-relative path prefixes that the agent is allowed to write to.
   * Example: `["src/content", "public/images"]`
   */
  allowedPaths: string[];
  /** Maximum number of change-sets a single user may submit per calendar day (UTC). */
  changesPerUserPerDay: number;
}

/**
 * A persisted audit record stored in KV for compliance and debugging.
 * @internal — used only by `auditLog()` but exported for external consumers.
 */
export interface AuditEntry {
  /** ISO 8601 timestamp of the event. */
  timestamp: string;
  /** Telegram user ID (or platform equivalent). */
  userId: string;
  /** Short description of the action attempted, e.g. `"file_edit"`. */
  action: string;
  /** List of repository paths involved in the change-set. */
  paths: string[];
  /** Final guardrail verdict. */
  outcome: 'allowed' | 'blocked';
  /** Reason string forwarded from the failing `GuardrailResult`, if any. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Seconds in one full day — used as KV TTL for rate-limit counters. */
const RATE_LIMIT_TTL_SECONDS = 86_400;

/** Seconds in 30 days — used as KV TTL for audit entries. */
const AUDIT_TTL_SECONDS = 2_592_000;

/**
 * File extensions that are ALWAYS blocked regardless of allowed path config.
 * These commonly store private keys, certificates, or environment secrets.
 */
const BLOCKED_EXTENSIONS: readonly string[] = [
  '.env',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
];

/**
 * Destructive / secret-revealing patterns checked against file content.
 * Each tuple is [regex, riskLevel, safeLabel] where `safeLabel` is the
 * sanitized description surfaced in the `reason` field (never the raw match).
 */
const DESTRUCTIVE_PATTERNS: ReadonlyArray<
  [RegExp, 'high' | 'critical', string]
> = [
  // --- Environment / secrets access ---
  [/process\.env/gi,                          'critical', 'process.env access'],
  [/require\(['"]dotenv/gi,                   'critical', 'dotenv require()'],
  [/import.*['"]dotenv/gi,                    'critical', 'dotenv import'],
  [/\bexec\s*\(/gi,                           'high',     'exec() call'],
  [/\beval\s*\(/gi,                           'high',     'eval() call'],
  [/child_process/gi,                         'high',     'child_process usage'],
  // --- Destructive shell / SQL ---
  [/rm\s+-rf/gi,                              'high',     'rm -rf command'],
  [/DROP\s+TABLE/gi,                          'high',     'DROP TABLE statement'],
  [/DELETE\s+FROM/gi,                         'high',     'DELETE FROM statement'],
  [/TRUNCATE\s+TABLE/gi,                      'high',     'TRUNCATE TABLE statement'],
  // --- Hard-coded credential markers ---
  [/__secret/gi,                              'critical', '__secret marker'],
  [/GITHUB_TOKEN/g,                           'critical', 'GITHUB_TOKEN literal'],
  [/TELEGRAM_BOT_TOKEN/g,                     'critical', 'TELEGRAM_BOT_TOKEN literal'],
  // eslint-disable-next-line no-useless-escape
  [/\bpassword\s*=\s*['"][^'"]{3,}/gi,        'critical', 'hard-coded password assignment'],
  [/-----BEGIN\s+(RSA\s+)?PRIVATE KEY/gi,     'critical', 'PEM private key block'],
  [/sk-[a-zA-Z0-9]{32,}/g,                   'critical', 'OpenAI-style API key'],
  [/ghp_[a-zA-Z0-9]{36}/g,                   'critical', 'GitHub personal access token'],
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns today's date string in `YYYY-MM-DD` format using UTC time.
 * Used to scope per-day rate-limit KV keys.
 */
function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Normalises a repo-relative path for security checks:
 * - Strips a leading `/`
 * - Resolves `.` and `..` segments WITHOUT touching the filesystem
 *   (We do NOT use `path.resolve` or `path.normalize` because those are
 *   Node APIs unavailable in the Workers runtime.)
 *
 * Returns the normalised path string.
 */
function normalizePath(rawPath: string): string {
  // Strip leading slash so every path is relative.
  const stripped = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;

  // Walk segments and resolve . / .. manually.
  const segments: string[] = [];
  for (const segment of stripped.split('/')) {
    if (segment === '' || segment === '.') {
      continue; // skip empty or current-dir segments
    } else if (segment === '..') {
      segments.pop(); // ascend — if already empty this is a traversal attempt
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

/**
 * Returns true if `normalizedPath` starts with any entry in `allowedPaths`
 * (after the allowed path itself is normalised).
 */
function isUnderAllowedPath(
  normalizedPath: string,
  allowedPaths: string[],
): boolean {
  for (const allowed of allowedPaths) {
    const normalizedAllowed = normalizePath(allowed);
    // Accept exact match OR the path being inside the directory (trailing /)
    if (
      normalizedPath === normalizedAllowed ||
      normalizedPath.startsWith(normalizedAllowed + '/')
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Exported guardrail functions
// ---------------------------------------------------------------------------

/**
 * Enforces a per-user, per-day rate limit using Cloudflare KV.
 *
 * The KV key pattern is `rate:<userId>:<YYYY-MM-DD>` (UTC date).
 * The counter is incremented on EVERY call — even when the limit has already
 * been reached — to deter hammering and provide accurate audit counts.
 *
 * @param userId - The unique identifier of the requesting user.
 * @param kv     - The KV namespace bound to the Worker (A3LIX_KV).
 * @param limit  - Maximum number of allowed requests for the day.
 * @returns A `GuardrailResult` indicating whether the request is within quota.
 */
export async function checkRateLimit(
  userId: string,
  kv: KVNamespace,
  limit: number,
): Promise<GuardrailResult> {
  // Guard against pathological inputs.
  if (!userId || typeof limit !== 'number' || limit < 1) {
    return {
      allowed: false,
      reason: 'Invalid rate-limit parameters.',
      riskLevel: 'high',
    };
  }

  const today = utcDateString();
  const key = `rate:${userId}:${today}`;

  // Read the current count; default to 0 if the key does not yet exist.
  const raw = await kv.get(key);
  const currentCount = raw !== null ? parseInt(raw, 10) : 0;

  // Increment regardless of the result to prevent hammering.
  const newCount = (isNaN(currentCount) ? 0 : currentCount) + 1;
  await kv.put(key, String(newCount), { expirationTtl: RATE_LIMIT_TTL_SECONDS });

  if (newCount > limit) {
    return {
      allowed: false,
      reason: `Daily change limit of ${limit} reached. Please try again tomorrow.`,
      riskLevel: 'high',
    };
  }

  return { allowed: true, riskLevel: 'safe' };
}

/**
 * Verifies that every requested file path falls inside the configured
 * allowed-path whitelist and does not attempt directory traversal or access
 * to sensitive file types.
 *
 * Blocks in order of severity:
 * 1. Path traversal (`..`) — riskLevel `critical`
 * 2. `.git/` prefix — riskLevel `critical`
 * 3. Blocked file extension — riskLevel `critical`
 * 4. Path outside all allowed prefixes — riskLevel `high`
 *
 * @param changes      - The list of proposed file mutations.
 * @param allowedPaths - Whitelisted path prefixes from `GuardrailConfig`.
 * @returns A `GuardrailResult` indicating whether all paths are permitted.
 */
export function checkAllowedPaths(
  changes: FileChange[],
  allowedPaths: string[],
): GuardrailResult {
  // An empty change-set is trivially safe.
  if (!changes || changes.length === 0) {
    return { allowed: true, riskLevel: 'safe' };
  }

  // Empty allowedPaths means nothing is permitted.
  if (!allowedPaths || allowedPaths.length === 0) {
    return {
      allowed: false,
      reason: 'No allowed paths are configured. All writes are blocked.',
      riskLevel: 'high',
    };
  }

  for (const change of changes) {
    const rawPath = change.path ?? '';

    // 1. Detect raw traversal sequences BEFORE normalisation — an attacker
    //    might rely on the normaliser to silently strip them.
    if (rawPath.includes('..')) {
      return {
        allowed: false,
        reason: `Path traversal attempt detected in "${rawPath}".`,
        riskLevel: 'critical',
      };
    }

    const normalizedPath = normalizePath(rawPath);

    // 2. Block any writes targeting the Git metadata directory.
    if (normalizedPath === '.git' || normalizedPath.startsWith('.git/')) {
      return {
        allowed: false,
        reason: `Writing to .git/ is forbidden (path: "${normalizedPath}").`,
        riskLevel: 'critical',
      };
    }

    // 3. Block sensitive file extensions — these are always off-limits.
    const lowerPath = normalizedPath.toLowerCase();
    for (const ext of BLOCKED_EXTENSIONS) {
      if (lowerPath.endsWith(ext)) {
        return {
          allowed: false,
          reason: `Files with the "${ext}" extension are not permitted.`,
          riskLevel: 'critical',
        };
      }
    }

    // 4. Ensure the path is within the declared allowed zone.
    if (!isUnderAllowedPath(normalizedPath, allowedPaths)) {
      return {
        allowed: false,
        reason: `Path "${normalizedPath}" is outside the permitted write zone.`,
        riskLevel: 'high',
      };
    }
  }

  return { allowed: true, riskLevel: 'safe' };
}

/**
 * Scans the content of every proposed file change for dangerous patterns:
 * secrets, credentials, destructive shell commands, and SQL data-destruction
 * statements.
 *
 * The `reason` field names the matched *pattern category* — it never echoes
 * the actual matched value to avoid leaking secrets in error messages.
 *
 * @param changes - The list of proposed file mutations.
 * @returns A `GuardrailResult` indicating whether all content is clean.
 */
export function checkDestructiveKeywords(
  changes: FileChange[],
): GuardrailResult {
  if (!changes || changes.length === 0) {
    return { allowed: true, riskLevel: 'safe' };
  }

  for (const change of changes) {
    // `delete` operations carry no content — skip the scan for them.
    if (change.operation === 'delete') {
      continue;
    }

    const content = change.content ?? '';
    if (typeof content !== 'string') {
      continue;
    }

    for (const [pattern, risk, label] of DESTRUCTIVE_PATTERNS) {
      // Reset lastIndex so repeated use of stateful (global) regexes is safe.
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        return {
          allowed: false,
          reason: `Blocked: detected "${label}" in "${change.path}".`,
          riskLevel: risk,
        };
      }
    }
  }

  return { allowed: true, riskLevel: 'safe' };
}

/**
 * Ensures that no proposed change uses the `delete` operation.
 *
 * A3lix agents are permitted to **create** and **update** files only.
 * Deletion is a one-way, potentially irreversible action and must always
 * require human approval outside this automated pipeline.
 *
 * @param changes - The list of proposed file mutations.
 * @returns A `GuardrailResult` that blocks any `delete` operation.
 */
export function checkOperationAllowed(changes: FileChange[]): GuardrailResult {
  if (!changes || changes.length === 0) {
    return { allowed: true, riskLevel: 'safe' };
  }

  for (const change of changes) {
    if (change.operation === 'delete') {
      return {
        allowed: false,
        reason: `File deletion is not permitted for automated agents (path: "${change.path}"). Please perform this action manually.`,
        riskLevel: 'high',
      };
    }
  }

  return { allowed: true, riskLevel: 'safe' };
}

/**
 * Runs the complete guardrail pipeline in the required order:
 *
 * 1. `checkRateLimit`         — async KV read / write
 * 2. `checkAllowedPaths`      — synchronous path validation
 * 3. `checkDestructiveKeywords` — synchronous content scan
 * 4. `checkOperationAllowed`  — synchronous operation check
 *
 * Short-circuit behaviour: the first failing check immediately returns its
 * result; subsequent checks are NOT evaluated. This prevents information
 * leakage about which later guards might also have triggered.
 *
 * @param params.changes  - Proposed file mutations from the AI agent.
 * @param params.userId   - Requesting user's identifier.
 * @param params.kv       - KV namespace (A3LIX_KV) for rate limiting.
 * @param params.config   - Runtime config from `agent.json`.
 * @returns A `GuardrailResult` — either the first failure or an all-clear.
 */
export async function runAllGuardrails(params: {
  changes: FileChange[];
  userId: string;
  kv: KVNamespace;
  config: GuardrailConfig;
}): Promise<GuardrailResult> {
  const { changes, userId, kv, config } = params;

  // 1 — Rate limit (async)
  const rateResult = await checkRateLimit(
    userId,
    kv,
    config.changesPerUserPerDay,
  );
  if (!rateResult.allowed) return rateResult;

  // 2 — Allowed paths (sync)
  const pathResult = checkAllowedPaths(changes, config.allowedPaths);
  if (!pathResult.allowed) return pathResult;

  // 3 — Destructive keyword scan (sync)
  const keywordResult = checkDestructiveKeywords(changes);
  if (!keywordResult.allowed) return keywordResult;

  // 4 — Operation check (sync)
  const opResult = checkOperationAllowed(changes);
  if (!opResult.allowed) return opResult;

  // All checks passed.
  return { allowed: true, riskLevel: 'safe' };
}

/**
 * Writes a structured audit entry to KV for compliance and post-incident
 * investigation.
 *
 * KV key pattern: `audit:<epoch-ms>:<userId>`
 * TTL: 30 days (2 592 000 seconds)
 *
 * **This function never throws.** Any KV write failure is silently swallowed
 * so that audit recording never interrupts the main request-handling flow.
 *
 * @param params.userId   - The requesting user's identifier.
 * @param params.action   - Short label for the action, e.g. `"file_edit"`.
 * @param params.paths    - Repository paths involved in the change-set.
 * @param params.outcome  - Whether the request was ultimately allowed or blocked.
 * @param params.reason   - The `reason` string from a blocking `GuardrailResult`, if any.
 * @param params.kv       - The KV namespace (A3LIX_KV) used for storage.
 */
export async function auditLog(params: {
  userId: string;
  action: string;
  paths: string[];
  outcome: 'allowed' | 'blocked';
  reason?: string;
  kv: KVNamespace;
}): Promise<void> {
  try {
    const { userId, action, paths, outcome, reason, kv } = params;

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      userId: userId ?? 'unknown',
      action: action ?? 'unknown',
      paths: Array.isArray(paths) ? paths : [],
      outcome,
      ...(reason !== undefined ? { reason } : {}),
    };

    const key = `audit:${Date.now()}:${userId}`;
    await kv.put(key, JSON.stringify(entry), {
      expirationTtl: AUDIT_TTL_SECONDS,
    });
  } catch {
    // Intentionally silent — audit failures must never break the request flow.
  }
}
