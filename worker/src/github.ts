/// <reference types="@cloudflare/workers-types" />

/**
 * @module github
 *
 * All GitHub API interactions for A3lix.
 *
 * This module is responsible for:
 *   - Reading the current main branch SHA
 *   - Creating live commits directly to the base branch
 *
 * All commits are authored and committed as "A3lix Bot <bot@a3lix.com>".
 * Multi-file commits use the GitHub Trees API for atomicity — all files land
 * in one commit or none.
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
 * Result of committing changes directly to the configured base branch.
 */
export interface LiveCommitResult {
  /** The SHA of the commit pushed to the base branch. */
  commitSha: string;
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
export async function githubFetch(
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
 * Commits changes directly to the configured base branch (`main` in most setups).
 *
 * Flow:
 * 1. Read current base branch SHA
 * 2. Read base commit tree SHA
 * 3. Create a new tree with all requested file changes
 * 4. Create a commit pointing to that tree
 * 5. Fast-forward the base branch ref to the new commit
 */
export async function createLiveCommit(params: {
  config: GitHubConfig;
  changes: GitHubFileChange[];
  commitMessage: string;
}): Promise<LiveCommitResult> {
  const { config, changes, commitMessage } = params;
  const { owner, repo, token, baseBranch } = config;

  // 1) Base SHA
  const baseSha = await getBaseBranchSha(config);

  // 2) Base tree SHA
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

  // 3) New tree
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

  // 4) Commit
  const createCommitEndpoint = `/repos/${owner}/${repo}/git/commits`;
  const now = new Date().toISOString();
  const createCommitData = await githubFetch(createCommitEndpoint, token, {
    method: 'POST',
    body: {
      message: commitMessage,
      tree: treeData.sha,
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

  // 5) Fast-forward base branch
  const updateRefEndpoint = `/repos/${owner}/${repo}/git/refs/heads/${baseBranch}`;
  await githubFetch(updateRefEndpoint, token, {
    method: 'PATCH',
    body: {
      sha: newCommitSha,
      force: false,
    },
  });

  return { commitSha: newCommitSha };
}
