/**
 * @file deployers/cloudflare-pages.ts
 *
 * Cloudflare Pages deployer — the reference implementation of the {@link Deployer} interface.
 *
 * Strategy: PASSIVE (push-triggered)
 * - The deployer pushes a branch to GitHub.
 * - Cloudflare Pages auto-detects the branch and builds a preview.
 * - No Cloudflare API token required in the worker.
 * - Preview URL is predictable and constructed deterministically.
 *
 * To add a new deployer (e.g. Vercel):
 *   1. Create `deployers/vercel.ts`.
 *   2. Implement the {@link Deployer} interface.
 *   3. Export a factory function named `createVercelDeployer`.
 *   4. Update `worker/src/deployer.ts` to import and use it.
 *
 * Prerequisites (client configures once in their Cloudflare dashboard):
 *   - GitHub repo connected to a Cloudflare Pages project.
 *   - Preview deployments enabled for all branches
 *     (Settings → Builds & deployments → Preview branches → All branches).
 *
 * Preview URL pattern:
 *   `https://{branch-slug}.{pages-project-name}.pages.dev`
 *
 * Where `branch-slug` is the branch name lowercased, with non-alphanumeric
 * characters (except `-`) replaced by `-`, consecutive hyphens collapsed,
 * leading/trailing hyphens stripped, and the result truncated to 63 characters.
 */

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

/**
 * Configuration required by all deployers.
 * Sourced from `agent.json` before being passed to a deployer factory.
 */
export interface DeployerConfig {
  /**
   * The name of the hosting project (e.g. a Cloudflare Pages project name,
   * a Vercel project name, etc.).
   * Example: `"my-awesome-site"`
   */
  projectName: string;

  /**
   * The frontend framework in use.
   * Used to calculate {@link Deployer.estimatedBuildSeconds}.
   */
  framework: 'astro' | 'nextjs';
}

/**
 * The contract every deployer must satisfy.
 *
 * A deployer is responsible for:
 * - Knowing how to derive the public preview URL for a given branch name.
 * - Reporting an estimated build duration to show the user while they wait.
 * - Optionally polling the hosting provider to check deployment status.
 *
 * All deployers operate on the same branch-push strategy: the agent pushes
 * a Git branch via `worker/src/github.ts` and the hosting platform's CI/CD
 * automation takes care of the rest.
 */
export interface Deployer {
  /**
   * Human-readable deployer name.
   * Used in log messages and user-facing error strings.
   * Example: `"Cloudflare Pages"`, `"Vercel"`, `"Netlify"`
   */
  readonly name: string;

  /**
   * Derives the full public preview URL for the given branch name.
   * The URL must be deterministic — no network calls are made here.
   *
   * @param branchName - The Git branch name, e.g. `preview-felix-20260307-a3f1`.
   * @returns The full preview URL, e.g.
   *          `https://preview-felix-20260307-a3f1.my-awesome-site.pages.dev`.
   */
  getPreviewUrl(branchName: string): string;

  /**
   * Returns the estimated build duration in seconds for this deployer,
   * based on the configured framework.
   * Shown to the user while Cloudflare Pages (or another platform) builds.
   *
   * @returns Positive integer number of seconds.
   */
  estimatedBuildSeconds(): number;

  /**
   * Optional: polls the hosting provider to check whether a deployment is
   * ready, still building, or has failed. Implementors should return `null`
   * if the deployer does not support status polling (e.g. the passive
   * Cloudflare Pages strategy that requires no API token).
   *
   * @param branchName - The preview branch to check.
   * @returns `'building'` | `'ready'` | `'failed'` | `null` (unsupported).
   */
  checkDeploymentStatus?(
    branchName: string,
  ): Promise<'building' | 'ready' | 'failed' | null>;
}

// ---------------------------------------------------------------------------
// Slug utility (duplicated from worker/src/deployer.ts intentionally)
// ---------------------------------------------------------------------------

/**
 * Converts a Git branch name to the URL-safe slug format used by Cloudflare
 * Pages for preview subdomain names.
 *
 * This function is intentionally duplicated from `worker/src/deployer.ts`
 * so that `deployers/cloudflare-pages.ts` has **zero local imports** and
 * can be used in Node.js CLI tooling outside the Cloudflare Workers runtime.
 *
 * Transform steps (applied in order):
 * 1. Lowercase the entire string.
 * 2. Replace any character that is not `a-z`, `0-9`, or `-` with `-`.
 * 3. Collapse consecutive `-` characters into a single `-`.
 * 4. Strip leading and trailing `-` characters.
 * 5. Truncate to 63 characters (Cloudflare Pages subdomain limit).
 *
 * @param branchName - The full Git branch name, e.g. `preview-felix-20260307-a3f1`.
 * @returns A Cloudflare Pages–compatible URL subdomain slug.
 * @internal
 */
function slugifyBranchName(branchName: string): string {
  return branchName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

// ---------------------------------------------------------------------------
// CloudflarePagesDeployer
// ---------------------------------------------------------------------------

/**
 * Reference implementation of {@link Deployer} for Cloudflare Pages.
 *
 * Uses the PASSIVE strategy — no Cloudflare API token is required.
 * Cloudflare Pages automatically detects new branches pushed to the connected
 * GitHub repo and starts a preview build. The preview URL is constructed
 * deterministically from the branch name and the Pages project name.
 *
 * @example
 * ```typescript
 * const deployer = createCloudflareDeployer({
 *   projectName: 'my-awesome-site',
 *   framework: 'astro',
 * });
 *
 * deployer.getPreviewUrl('preview-felix-20260307-a3f1');
 * // → 'https://preview-felix-20260307-a3f1.my-awesome-site.pages.dev'
 *
 * deployer.estimatedBuildSeconds(); // → 45
 * ```
 */
export class CloudflarePagesDeployer implements Deployer {
  /** Human-readable deployer name used in logs and error messages. */
  readonly name = 'Cloudflare Pages';

  /**
   * @param config - Deployer configuration (project name and framework).
   */
  constructor(private readonly config: DeployerConfig) {}

  /**
   * Builds the predictable Cloudflare Pages preview URL for a given branch name.
   *
   * The slug transform lowercases the branch name, replaces non-alphanumeric
   * characters with `-`, collapses consecutive hyphens, strips leading/trailing
   * hyphens, and truncates to 63 characters.
   *
   * @param branchName - The Git branch name, e.g. `preview-felix-20260307-a3f1`.
   * @returns Full preview URL, e.g.
   *          `https://preview-felix-20260307-a3f1.my-awesome-site.pages.dev`.
   */
  getPreviewUrl(branchName: string): string {
    const slug = slugifyBranchName(branchName);
    return `https://${slug}.${this.config.projectName}.pages.dev`;
  }

  /**
   * Returns the estimated build duration in seconds.
   * Astro projects build faster than Next.js projects.
   *
   * - `astro`  → 45 seconds
   * - `nextjs` → 60 seconds
   *
   * @returns Estimated build seconds as a positive integer.
   */
  estimatedBuildSeconds(): number {
    return this.config.framework === 'astro' ? 45 : 60;
  }

  /**
   * Returns `null` — the passive Cloudflare Pages strategy does not poll the
   * Cloudflare API for build status (no `CF_API_TOKEN` is stored in the worker).
   *
   * If you need real-time status polling, implement a separate deployer that
   * uses the Cloudflare Pages REST API with an API token, and override this
   * method to return the actual deployment status.
   *
   * @param _branchName - Ignored. Deployment status is not checked.
   * @returns Always `null`.
   */
  async checkDeploymentStatus(
    _branchName: string,
  ): Promise<'building' | 'ready' | 'failed' | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory function for {@link CloudflarePagesDeployer}.
 *
 * Prefer this function over constructing `CloudflarePagesDeployer` directly
 * so that call sites depend on the {@link Deployer} interface rather than the
 * concrete class.
 *
 * @param config - Deployer configuration (project name and framework).
 * @returns A new {@link CloudflarePagesDeployer} instance.
 *
 * @example
 * ```typescript
 * const deployer: Deployer = createCloudflareDeployer({
 *   projectName: 'my-awesome-site',
 *   framework: 'nextjs',
 * });
 * ```
 */
export function createCloudflareDeployer(
  config: DeployerConfig,
): CloudflarePagesDeployer {
  return new CloudflarePagesDeployer(config);
}
