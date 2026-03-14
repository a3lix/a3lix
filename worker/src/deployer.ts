/// <reference types="@cloudflare/workers-types" />

/**
 * @module deployer
 *
 * Deploy orchestrator for A3lix.
 *
 * Coordinates the passive Cloudflare Pages preview-deploy strategy:
 *   1. Push a preview branch to GitHub via {@link createPreviewBranch}
 *   2. Cloudflare Pages auto-detects the new branch and builds a preview
 *
 * After the site owner reviews and approves the preview, {@link approveAndMerge}
 * merges the preview branch into main and cleans up the ref.
 */

import type { GitHubConfig, GitHubFileChange } from './github';

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

