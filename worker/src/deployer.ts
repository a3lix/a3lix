/// <reference types="@cloudflare/workers-types" />

/**
 * @module deployer
 *
 * Deploy orchestrator for A3lix.
 *
 * Coordinates the passive Cloudflare Pages preview-deploy strategy:
 *   1. Push a preview branch to GitHub via {@link createPreviewBranch}
 *   2. Cloudflare Pages auto-detects the new branch and builds a preview
 *   3. Return the predictable preview URL to the caller — no CF API token needed
 *
 * After the site owner reviews and approves the preview, {@link approveAndMerge}
 * merges the preview branch into main and cleans up the ref.
 *
 * Preview URL pattern:
 *   `https://{branch-slug}.{pages-project-name}.pages.dev`
 *
 * Where `branch-slug` is the branch name lowercased, with non-alphanumeric
 * characters (except `-`) replaced by `-`, consecutive hyphens collapsed,
 * leading/trailing hyphens stripped, and the result truncated to 63 characters.
 */

import type { GitHubConfig, GitHubFileChange } from './github';
import { createPreviewBranch, mergeToMain } from './github';

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

/**
 * Configuration for a deploy operation, sourced from `agent.json`.
 */
export interface DeployConfig {
  /**
   * Cloudflare Pages project name, from `agent.json → cloudflare.pagesProjectName`.
   * Used to construct the predictable preview URL.
   * Example: `"my-awesome-site"`
   */
  pagesProjectName: string;

  /**
   * The project's frontend framework, from `agent.json → project.framework`.
   * Used to estimate build duration shown to the user while they wait.
   */
  framework: 'astro' | 'nextjs';
}

/**
 * The result of a successful preview deployment initiated by {@link deployPreview}.
 */
export interface DeployResult {
  /**
   * The preview branch name pushed to GitHub.
   * Example: `preview-felix-20260307-a3f1`
   */
  branchName: string;

  /**
   * The predictable Cloudflare Pages preview URL for this branch.
   * Example: `https://preview-felix-20260307-a3f1.my-awesome-site.pages.dev`
   */
  previewUrl: string;

  /**
   * The SHA of the commit that was pushed to the preview branch.
   * Can be used to verify the exact content deployed.
   */
  commitSha: string;

  /**
   * ISO 8601 UTC timestamp of when the branch was pushed.
   * Example: `"2026-03-07T14:32:00.000Z"`
   */
  deployedAt: string;

  /**
   * Estimated build duration in seconds, shown to the user while they wait.
   * Derived from `DeployConfig.framework`: Astro = 45 s, Next.js = 60 s.
   */
  estimatedBuildSeconds: number;
}

// ---------------------------------------------------------------------------
// Exported utility
// ---------------------------------------------------------------------------

/**
 * Converts a Git branch name to the URL-safe slug format used by Cloudflare
 * Pages for preview subdomain names.
 *
 * Transform steps (applied in order):
 * 1. Lowercase the entire string.
 * 2. Replace any character that is not `a-z`, `0-9`, or `-` with `-`.
 * 3. Collapse consecutive `-` characters into a single `-`.
 * 4. Strip leading and trailing `-` characters.
 * 5. Truncate to 63 characters (Cloudflare Pages subdomain limit).
 *
 * @param branchName      - The full Git branch name, e.g. `preview-felix-20260307-a3f1`.
 * @param pagesProjectName - The Cloudflare Pages project name, e.g. `my-awesome-site`.
 * @returns The full predictable preview URL,
 *          e.g. `https://preview-felix-20260307-a3f1.my-awesome-site.pages.dev`.
 *
 * @example
 * buildPreviewUrl('preview-felix-20260307-a3f1', 'my-awesome-site');
 * // → 'https://preview-felix-20260307-a3f1.my-awesome-site.pages.dev'
 */
export function buildPreviewUrl(
  branchName: string,
  pagesProjectName: string,
): string {
  const slug = branchName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

  return `https://${slug}.${pagesProjectName}.pages.dev`;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Creates a preview deployment by pushing a new branch to GitHub.
 *
 * Cloudflare Pages automatically detects the new branch and builds a preview.
 * No Cloudflare API token is needed. The preview URL is constructed
 * deterministically from the branch name and the Pages project name.
 *
 * Steps:
 * 1. Builds the commit message embedding the human-readable `summary` and
 *    the requesting `userId`.
 * 2. Calls {@link createPreviewBranch} to atomically push all `changes`
 *    to a new branch via the GitHub Trees API.
 * 3. Assembles and returns a {@link DeployResult} with the branch name,
 *    preview URL, commit SHA, timestamp, and estimated build time.
 *
 * @param params.githubConfig  - GitHub connection config (token, owner, repo, baseBranch).
 * @param params.deployConfig  - Deploy config (pagesProjectName, framework).
 * @param params.userId        - Unique identifier of the user requesting the deploy.
 *                               Embedded in the commit message and used for branch naming.
 * @param params.changes       - One or more files to include in this preview commit.
 * @param params.summary       - Human-readable description of the changes, embedded
 *                               in the commit message.
 * @returns A {@link DeployResult} describing the completed preview deployment.
 * @throws {@link GitHubError} if any GitHub API call fails.
 */
export async function deployPreview(params: {
  githubConfig: GitHubConfig;
  deployConfig: DeployConfig;
  userId: string;
  changes: GitHubFileChange[];
  summary: string;
}): Promise<DeployResult> {
  const { githubConfig, deployConfig, userId, changes, summary } = params;

  const commitMessage =
    `feat: A3lix preview — ${summary}\n\nRequested by user ${userId}\nGenerated by A3lix Bot`;

  const result = await createPreviewBranch({
    config: githubConfig,
    userId,
    changes,
    commitMessage,
    pagesProjectName: deployConfig.pagesProjectName,
  });

  const estimatedBuildSeconds = deployConfig.framework === 'astro' ? 45 : 60;

  return {
    branchName: result.branchName,
    previewUrl: result.previewUrl,
    commitSha: result.commitSha,
    deployedAt: new Date().toISOString(),
    estimatedBuildSeconds,
  };
}

/**
 * Merges an approved preview branch into the base branch and cleans up the ref.
 *
 * Called after the site owner reviews the preview and gives approval.
 * Delegates to {@link mergeToMain} which:
 *   - Issues `POST /repos/{owner}/{repo}/merges` to merge the branch.
 *   - Issues `DELETE /repos/{owner}/{repo}/git/refs/heads/{branchName}` to clean up.
 *
 * @param params.githubConfig - GitHub connection config (token, owner, repo, baseBranch).
 * @param params.branchName   - The preview branch to merge, e.g. `preview-felix-20260307-a3f1`.
 * @param params.summary      - Human-readable description of the approved changes,
 *                              embedded in the merge commit message.
 * @param params.userId       - Unique identifier of the approving owner.
 *                              Embedded in the merge commit message.
 * @returns An object containing the `commitSha` of the merge commit.
 * @throws {@link GitHubError} if the merge API call fails.
 * @throws {Error} If the GitHub API returns a no-op (204) response, indicating
 *                 the branch had no new commits to merge.
 */
export async function approveAndMerge(params: {
  githubConfig: GitHubConfig;
  branchName: string;
  summary: string;
  userId: string;
}): Promise<{ commitSha: string }> {
  const { githubConfig, branchName, summary, userId } = params;

  const commitMessage =
    `feat: A3lix approved — ${summary}\n\nApproved by owner ${userId}\nMerged by A3lix Bot`;

  const result = await mergeToMain(githubConfig, branchName, commitMessage);

  if (!result.merged) {
    throw new Error(
      `Merge of branch "${branchName}" was a no-op — no new commits to merge.`,
    );
  }

  return { commitSha: result.commitSha };
}
