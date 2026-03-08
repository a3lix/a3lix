/// <reference types="@cloudflare/workers-types" />

/**
 * @module github
 *
 * All GitHub API interactions for A3lix.
 *
 * This module is responsible for:
 *   - Reading the current main branch SHA
 *   - Creating preview branches with atomic multi-file commits (Trees API)
 *   - Merging preview branches to main after owner approval
 *   - Storing, retrieving, listing, and deleting pending approval records in KV
 *
 * Branch naming convention: `preview-{slug}-{YYYYMMDD}-{4-char-hex}`
 * e.g. `preview-felix--20260307-a3f1`
 *
 * All commits are authored and committed as "A3lix Bot <bot@a3lix.com>".
 * Multi-file commits use the GitHub Trees API for atomicity — all files land
 * in one commit or none.
 *
 * No Pull Requests are created. Cloudflare Pages auto-detects and builds
 * the preview branch directly.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base URL for the GitHub REST API. */
const GITHUB_API_BASE = 'https://api.github.com';

/** User-Agent header sent with every GitHub API request. */
const USER_AGENT = 'A3lix-Bot/0.1';

/** Commit author identity for all agent-generated commits. */
const BOT_AUTHOR = { name: 'A3lix Bot', email: 'bot@a3lix.com' };

/** KV TTL for pending approval records — 24 hours in seconds. */
const APPROVAL_TTL_SECONDS = 86_400;

/** KV key prefix for pending approval records. */
const APPROVAL_KEY_PREFIX = 'approval:';

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

/**
 * Configuration for GitHub operations.
 * Sourced from `agent.json` (owner/repo) and the `GITHUB_TOKEN` wrangler secret.
 */
export interface GitHubConfig {
  /** Fine-grained Personal Access Token from the `GITHUB_TOKEN` wrangler secret. */
  token: string;
  /** GitHub username or organisation name (the first segment of the `repo` field in `agent.json`). */
  owner: string;
  /** Repository name (the second segment of the `repo` field in `agent.json`). */
  repo: string;
  /** The base branch that preview branches are forked from, e.g. `'main'`. */
  baseBranch: string;
}

/**
 * A single file to commit to GitHub.
 * Mirrors {@link FileChange} from `parser.ts` but is deliberately decoupled
 * to keep this module dependency-free.
 */
export interface GitHubFileChange {
  /** Repo-relative path, e.g. `src/content/blog/my-post.md`. */
  path: string;
  /** Complete UTF-8 file content. Never partial. */
  content: string;
  /** The mutation type. `delete` is not supported by this module. */
  operation: 'create' | 'update';
}

/**
 * The result of creating a preview branch with one or more committed files.
 */
export interface PreviewBranchResult {
  /** The full branch name, e.g. `preview-felix--20260307-a3f1`. */
  branchName: string;
  /** The SHA of the commit that was pushed to the preview branch. */
  commitSha: string;
  /**
   * The Cloudflare Pages preview URL derived from the branch name.
   * Pattern: `https://{slugifiedBranch}.{pagesProjectName}.pages.dev`
   */
  previewUrl: string;
}

/**
 * The result of merging a preview branch to the base branch.
 */
export interface MergeResult {
  /** Whether the merge succeeded (true) or was a no-op (false, 204 response). */
  merged: boolean;
  /** SHA of the resulting merge commit, or the existing HEAD SHA on no-op. */
  commitSha: string;
  /** Whether the preview branch ref was deleted after merging. */
  branchDeleted: boolean;
}

/**
 * An approval record stored in KV while waiting for the owner to approve
 * or reject a proposed change-set.
 */
export interface PendingApproval {
  /** The name of the preview branch holding the changes. */
  branchName: string;
  /** Telegram user ID (or equivalent) of whoever requested the change. */
  requestedByUserId: string;
  /** ISO 8601 UTC timestamp of when the approval was created. */
  requestedAt: string;
  /** ISO 8601 UTC timestamp after which this approval record expires (24 h). */
  expiresAt: string;
  /** The file changes included in this preview branch. */
  changes: GitHubFileChange[];
  /** Human-readable description of what will be merged, shown in the approval prompt. */
  summary: string;
  /** Cloudflare Pages project name, used to build the preview URL. */
  pagesProjectName: string;
}

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link githubFetch} and all exported functions when the GitHub
 * API returns a non-2xx status code.
 */
export class GitHubError extends Error {
  /**
   * @param message  - Human-readable detail, usually the GitHub error body text.
   * @param status   - The HTTP status code returned by the GitHub API.
   * @param endpoint - The API endpoint path that was called (e.g. `/repos/owner/repo/git/ref/heads/main`).
   */
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

// ---------------------------------------------------------------------------
// Internal type guards
// ---------------------------------------------------------------------------

/**
 * Narrows an `unknown` value to a GitHub ref response shape.
 * Expected: `{ object: { sha: string } }`
 * @internal
 */
function isGitHubRefResponse(
  value: unknown,
): value is { object: { sha: string } } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const obj = v['object'];
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o['sha'] === 'string';
}

/**
 * Narrows an `unknown` value to a GitHub commit response shape.
 * Expected: `{ tree: { sha: string } }`
 * @internal
 */
function isGitHubCommitResponse(
  value: unknown,
): value is { tree: { sha: string } } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const tree = v['tree'];
  if (typeof tree !== 'object' || tree === null) return false;
  const t = tree as Record<string, unknown>;
  return typeof t['sha'] === 'string';
}

/**
 * Narrows an `unknown` value to a GitHub tree creation response shape.
 * Expected: `{ sha: string }`
 * @internal
 */
function isGitHubTreeResponse(value: unknown): value is { sha: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['sha'] === 'string';
}

/**
 * Narrows an `unknown` value to a GitHub commit creation response shape.
 * Expected: `{ sha: string }`
 * @internal
 */
function isGitHubCreateCommitResponse(value: unknown): value is { sha: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['sha'] === 'string';
}

/**
 * Narrows an `unknown` value to a GitHub merge response shape.
 * Expected: `{ sha: string }`
 * @internal
 */
function isGitHubMergeResponse(value: unknown): value is { sha: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['sha'] === 'string';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sends an authenticated request to the GitHub REST API and returns the
 * parsed JSON response body as `unknown`.
 *
 * Headers sent on every request:
 * - `Authorization: Bearer <token>`
 * - `Accept: application/vnd.github+json`
 * - `X-GitHub-Api-Version: 2022-11-28`
 * - `User-Agent: A3lix-Bot/0.1`
 * - `Content-Type: application/json`
 *
 * @param endpoint - API path, e.g. `/repos/owner/repo/git/ref/heads/main`.
 * @param token    - Fine-grained GitHub PAT.
 * @param options  - Optional HTTP method (defaults to `'GET'`) and request body.
 * @returns Parsed JSON response body as `unknown`. Callers must narrow the type.
 * @throws {@link GitHubError} when the response status is not 2xx.
 * @internal
 */
async function githubFetch(
  endpoint: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const url = `${GITHUB_API_BASE}${endpoint}`;
  const method = options.method ?? 'GET';

  const init: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
  };

  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    const bodyText = await response.text();
    throw new GitHubError(bodyText, response.status, endpoint);
  }

  return response.json() as Promise<unknown>;
}

/**
 * Converts a branch name to the URL-safe slug format expected by Cloudflare
 * Pages preview URLs: lowercase, `/` and non-alphanumeric characters replaced
 * with `-`, truncated to 63 characters (the Cloudflare Pages subdomain limit).
 *
 * @param branchName - The full branch name, e.g. `preview-felix--20260307-a3f1`.
 * @returns A Cloudflare Pages–compatible URL slug.
 * @internal
 */
function slugifyBranch(branchName: string): string {
  return branchName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63);
}

// ---------------------------------------------------------------------------
// Exported functions — branch naming
// ---------------------------------------------------------------------------

/**
 * Generates a unique preview branch name for a given user.
 *
 * Pattern: `preview-{slug}-{YYYYMMDD}-{hex4}`
 *
 * - `slug`: the `userId` lowercased with non-alphanumeric characters replaced
 *   by `-`, truncated to 12 characters.
 * - `YYYYMMDD`: UTC date at the time of the call.
 * - `hex4`: 4-character lowercase hex string from 2 random bytes produced by
 *   `crypto.getRandomValues()` (available globally in the Workers runtime).
 *
 * Example output: `preview-felix--20260307-a3f1`
 *
 * @param userId - The unique identifier of the requesting user.
 * @returns A branch name string safe for use as a Git ref.
 */
export function generateBranchName(userId: string): string {
  // Build slug: lowercase, non-alphanumeric → '-', max 12 chars.
  const slug = userId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 12);

  // Build YYYYMMDD from UTC date.
  const now = new Date();
  const year  = now.getUTCFullYear().toString();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const day   = now.getUTCDate().toString().padStart(2, '0');
  const yyyymmdd = `${year}${month}${day}`;

  // Generate 4-char hex from 2 random bytes.
  const randomBytes = new Uint8Array(2);
  crypto.getRandomValues(randomBytes);
  const hex4 = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `preview-${slug}-${yyyymmdd}-${hex4}`;
}

// ---------------------------------------------------------------------------
// Exported functions — GitHub API operations
// ---------------------------------------------------------------------------

/**
 * Fetches the latest commit SHA of the configured base branch.
 *
 * GitHub API: `GET /repos/{owner}/{repo}/git/ref/heads/{baseBranch}`
 *
 * @param config - GitHub connection config (token, owner, repo, baseBranch).
 * @returns The SHA string of the latest commit on the base branch.
 * @throws {@link GitHubError} when the API returns a non-2xx status.
 */
export async function getBaseBranchSha(config: GitHubConfig): Promise<string> {
  const endpoint = `/repos/${config.owner}/${config.repo}/git/ref/heads/${config.baseBranch}`;
  const data = await githubFetch(endpoint, config.token);

  if (!isGitHubRefResponse(data)) {
    throw new GitHubError(
      `Unexpected response shape from GET ${endpoint}`,
      200,
      endpoint,
    );
  }

  return data.object.sha;
}

/**
 * Creates a preview branch with an atomic multi-file commit using the
 * GitHub Trees API.
 *
 * Full 5-step flow:
 * 1. `GET  /repos/{owner}/{repo}/git/ref/heads/{baseBranch}` — get base SHA
 * 2. `GET  /repos/{owner}/{repo}/git/commits/{sha}` — get tree SHA
 * 3. `POST /repos/{owner}/{repo}/git/trees` — create new tree (all files)
 * 4. `POST /repos/{owner}/{repo}/git/commits` — create commit
 * 5. `POST /repos/{owner}/{repo}/git/refs` — create branch ref
 *
 * All files land in a single commit or none (Trees API atomicity).
 * The commit is authored and committed as `A3lix Bot <bot@a3lix.com>`.
 *
 * @param params.config           - GitHub connection config.
 * @param params.userId           - Used to generate the branch name slug.
 * @param params.changes          - One or more files to include in the commit.
 * @param params.commitMessage    - Git commit message.
 * @param params.pagesProjectName - Cloudflare Pages project name, used to build the preview URL.
 * @returns A {@link PreviewBranchResult} with branch name, commit SHA, and preview URL.
 * @throws {@link GitHubError} on any GitHub API failure.
 */
export async function createPreviewBranch(params: {
  config: GitHubConfig;
  userId: string;
  changes: GitHubFileChange[];
  commitMessage: string;
  pagesProjectName: string;
}): Promise<PreviewBranchResult> {
  const { config, userId, changes, commitMessage, pagesProjectName } = params;
  const { owner, repo, token } = config;

  // ── Step 1: Get base branch SHA ───────────────────────────────────────────
  const baseSha = await getBaseBranchSha(config);

  // ── Step 2: Get the tree SHA of the base commit ───────────────────────────
  const commitEndpoint = `/repos/${owner}/${repo}/git/commits/${baseSha}`;
  const commitData = await githubFetch(commitEndpoint, token);

  if (!isGitHubCommitResponse(commitData)) {
    throw new GitHubError(
      `Unexpected response shape from GET ${commitEndpoint}`,
      200,
      commitEndpoint,
    );
  }

  const treeSha = commitData.tree.sha;

  // ── Step 3: Create new tree with all files ────────────────────────────────
  const treeEndpoint = `/repos/${owner}/${repo}/git/trees`;
  const treeData = await githubFetch(treeEndpoint, token, {
    method: 'POST',
    body: {
      base_tree: treeSha,
      tree: changes.map((change) => ({
        path: change.path,
        mode: '100644',
        type: 'blob',
        content: change.content,
      })),
    },
  });

  if (!isGitHubTreeResponse(treeData)) {
    throw new GitHubError(
      `Unexpected response shape from POST ${treeEndpoint}`,
      201,
      treeEndpoint,
    );
  }

  const newTreeSha = treeData.sha;

  // ── Step 4: Create the commit ─────────────────────────────────────────────
  const createCommitEndpoint = `/repos/${owner}/${repo}/git/commits`;
  const now = new Date().toISOString();
  const createCommitData = await githubFetch(createCommitEndpoint, token, {
    method: 'POST',
    body: {
      message: commitMessage,
      tree: newTreeSha,
      parents: [baseSha],
      author: {
        name: BOT_AUTHOR.name,
        email: BOT_AUTHOR.email,
        date: now,
      },
      committer: {
        name: BOT_AUTHOR.name,
        email: BOT_AUTHOR.email,
        date: now,
      },
    },
  });

  if (!isGitHubCreateCommitResponse(createCommitData)) {
    throw new GitHubError(
      `Unexpected response shape from POST ${createCommitEndpoint}`,
      201,
      createCommitEndpoint,
    );
  }

  const newCommitSha = createCommitData.sha;

  // ── Step 5: Create the branch ref ─────────────────────────────────────────
  const branchName = generateBranchName(userId);
  const createRefEndpoint = `/repos/${owner}/${repo}/git/refs`;
  await githubFetch(createRefEndpoint, token, {
    method: 'POST',
    body: {
      ref: `refs/heads/${branchName}`,
      sha: newCommitSha,
    },
  });

  // ── Build Cloudflare Pages preview URL ────────────────────────────────────
  const slug = slugifyBranch(branchName);
  const previewUrl = `https://${slug}.${pagesProjectName}.pages.dev`;

  return {
    branchName,
    commitSha: newCommitSha,
    previewUrl,
  };
}

/**
 * Merges a preview branch into the base branch and then deletes the preview
 * branch ref.
 *
 * GitHub API calls:
 * 1. `POST   /repos/{owner}/{repo}/merges` — merge preview → base
 * 2. `DELETE /repos/{owner}/{repo}/git/refs/heads/{branchName}` — clean up
 *
 * A 201 response indicates a new merge commit was created (`merged: true`).
 * A 204 response indicates the branch was already up-to-date or had no new
 * commits; the merge is treated as a no-op (`merged: false`) and the function
 * still attempts to delete the preview branch.
 *
 * @param config        - GitHub connection config.
 * @param branchName    - The preview branch to merge and delete.
 * @param commitMessage - The commit message for the merge commit.
 * @returns A {@link MergeResult} describing the outcome.
 * @throws {@link GitHubError} on any GitHub API failure (excluding 204 on merge).
 */
export async function mergeToMain(
  config: GitHubConfig,
  branchName: string,
  commitMessage: string,
): Promise<MergeResult> {
  const { owner, repo, token, baseBranch } = config;

  // ── Step 6: Merge preview branch to base ──────────────────────────────────
  const mergeEndpoint = `/repos/${owner}/${repo}/merges`;
  const mergeUrl = `${GITHUB_API_BASE}${mergeEndpoint}`;

  const mergeResponse = await fetch(mergeUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      base: baseBranch,
      head: branchName,
      commit_message: commitMessage,
    }),
  });

  let merged = false;
  let commitSha = '';

  if (mergeResponse.status === 201) {
    // A new merge commit was created.
    merged = true;
    const mergeData = await mergeResponse.json() as unknown;
    if (!isGitHubMergeResponse(mergeData)) {
      throw new GitHubError(
        `Unexpected response shape from POST ${mergeEndpoint}`,
        201,
        mergeEndpoint,
      );
    }
    commitSha = mergeData.sha;
  } else if (mergeResponse.status === 204) {
    // Already merged / no new commits — no-op, no body to parse.
    merged = false;
    commitSha = '';
  } else {
    // Any other non-2xx status is an error.
    const bodyText = await mergeResponse.text();
    throw new GitHubError(bodyText, mergeResponse.status, mergeEndpoint);
  }

  // ── Step 7: Delete the preview branch ref ─────────────────────────────────
  const deleteEndpoint = `/repos/${owner}/${repo}/git/refs/heads/${branchName}`;
  let branchDeleted = false;

  try {
    await githubFetch(deleteEndpoint, token, { method: 'DELETE' });
    branchDeleted = true;
  } catch {
    // Deletion failure is non-fatal — the merge already succeeded.
    branchDeleted = false;
  }

  return { merged, commitSha, branchDeleted };
}

// ---------------------------------------------------------------------------
// Exported functions — KV approval management
// ---------------------------------------------------------------------------

/**
 * Persists a {@link PendingApproval} record in KV, keyed by `approvalId`.
 *
 * KV key: `approval:{approvalId}`
 * TTL: 86 400 seconds (24 hours)
 *
 * The `approvalId` is always the `branchName` so it can be used consistently
 * as the lookup key throughout the approval flow.
 *
 * @param approvalId - Unique identifier for the approval (use `branchName`).
 * @param approval   - The full {@link PendingApproval} data to store.
 * @param kv         - The KV namespace (A3LIX_KV).
 */
export async function storePendingApproval(
  approvalId: string,
  approval: PendingApproval,
  kv: KVNamespace,
): Promise<void> {
  const key = `${APPROVAL_KEY_PREFIX}${approvalId}`;
  await kv.put(key, JSON.stringify(approval), {
    expirationTtl: APPROVAL_TTL_SECONDS,
  });
}

/**
 * Retrieves and parses a {@link PendingApproval} record from KV.
 *
 * KV key: `approval:{approvalId}`
 *
 * Returns `null` if the key does not exist or if the stored value cannot be
 * parsed as a valid JSON object.
 *
 * @param approvalId - The approval identifier to look up (the `branchName`).
 * @param kv         - The KV namespace (A3LIX_KV).
 * @returns The parsed {@link PendingApproval}, or `null` on miss or parse failure.
 */
export async function getPendingApproval(
  approvalId: string,
  kv: KVNamespace,
): Promise<PendingApproval | null> {
  const key = `${APPROVAL_KEY_PREFIX}${approvalId}`;
  const raw = await kv.get(key);

  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as PendingApproval;
  } catch {
    return null;
  }
}

/**
 * Removes a pending approval record from KV.
 *
 * KV key: `approval:{approvalId}`
 *
 * This function **never throws** — any KV deletion failure is silently
 * swallowed so that cleanup never interrupts the main request flow.
 *
 * @param approvalId - The approval identifier to delete (the `branchName`).
 * @param kv         - The KV namespace (A3LIX_KV).
 */
export async function deletePendingApproval(
  approvalId: string,
  kv: KVNamespace,
): Promise<void> {
  try {
    const key = `${APPROVAL_KEY_PREFIX}${approvalId}`;
    await kv.delete(key);
  } catch {
    // Intentionally silent — deletion failures must never break the request flow.
  }
}

/**
 * Returns all non-expired {@link PendingApproval} records from KV, sorted by
 * `requestedAt` ascending (oldest first).
 *
 * Algorithm:
 * 1. Lists all KV keys with prefix `approval:` using KV `list()`.
 * 2. Fetches and parses each value.
 * 3. Filters out records whose `expiresAt` timestamp is in the past.
 * 4. Sorts the remaining records by `requestedAt` ascending.
 *
 * Parse failures and missing values are silently skipped.
 *
 * @param kv - The KV namespace (A3LIX_KV).
 * @returns An array of valid, non-expired {@link PendingApproval} objects.
 */
export async function listPendingApprovals(
  kv: KVNamespace,
): Promise<PendingApproval[]> {
  const listResult = await kv.list({ prefix: APPROVAL_KEY_PREFIX });

  const now = new Date().toISOString();
  const approvals: PendingApproval[] = [];

  for (const key of listResult.keys) {
    const raw = await kv.get(key.name);
    if (raw === null) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null) continue;

    const entry = parsed as PendingApproval;

    // Filter out expired approvals.
    if (typeof entry.expiresAt === 'string' && entry.expiresAt <= now) {
      continue;
    }

    approvals.push(entry);
  }

  // Sort by requestedAt ascending (oldest first).
  approvals.sort((a, b) => {
    const aTime = typeof a.requestedAt === 'string' ? a.requestedAt : '';
    const bTime = typeof b.requestedAt === 'string' ? b.requestedAt : '';
    return aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
  });

  return approvals;
}
