#!/usr/bin/env node
/**
 * setup/cli.ts — A3lix interactive CLI wizard
 *
 * Runs in Node.js (NOT in the Cloudflare Worker runtime).
 * Executed when a client runs: npx a3lixcms@latest init | update | status | whoami
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import fetch from 'node-fetch';
import { randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentJson {
  project: {
    name: string;
    repo: string;
    branch: string;
    framework: string;
  };
  bot: {
    platform: 'telegram';
    ownerChatId: string;
  };
  ai: {
    provider: string;
    model: string;
  };
  paths: {
    allowed: string[];
  };
  roles: {
    editors: string[];
    viewers: string[];
  };
  limits: {
    changesPerUserPerDay: number;
    previewExpiryHours: number;
    requireApprovalForAll: boolean;
  };
  cloudflare: {
    pagesProjectName: string;
  };
}

interface UserRecord {
  chatId: string;
  role: 'owner';
  addedAt: string;
  addedBy: 'cli';
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface InitAnswers {
  projectName: string;
  repo: string;
  branch: string;
  framework: string;
  pagesProjectName: string;
  telegramBotToken: string;
  ownerChatId: string;
  aiProvider: string;
  aiModel: string;
  aiApiKey: string | undefined;
  githubToken: string;
  kvNamespaceId: string;
  webhookSecret: string;
}

// ---------------------------------------------------------------------------
// Default AI models per provider
// ---------------------------------------------------------------------------

const DEFAULT_AI_MODELS: Record<string, string> = {
  'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8',
  openai: 'gpt-4o-mini',
  claude: 'claude-3-5-haiku-20241022',
  grok: 'grok-3-mini',
  groq: 'llama-3.3-70b-versatile',
  gemini: 'gemini-2.0-flash-lite',
  openrouter: 'google/gemini-2.0-flash-lite:free',
};

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Runs a CLI command using child_process.spawn.
 * Never throws — returns exit code, stdout and stderr instead.
 *
 * @param cmd  - The executable to run (e.g. 'npx')
 * @param args - Arguments array (e.g. ['wrangler', 'deploy'])
 * @param opts - Optional: `input` piped to stdin; `cwd` working directory
 * @returns    Promise resolving to { stdout, stderr, exitCode }
 */
export async function runCommand(
  cmd: string,
  args: string[],
  opts?: { input?: string; cwd?: string }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (opts?.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }

    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on('error', (err: Error) => {
      resolve({ stdout, stderr: `${stderr}\n${err.message}`, exitCode: 1 });
    });
  });
}

/**
 * Generates a cryptographically random hex string.
 *
 * @param bytes - Number of random bytes (hex output is 2× this length)
 * @returns     Hex string
 */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Converts a human-readable string to a URL/slug-friendly format.
 *
 * @param text - Input string
 * @returns    Slugified string
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Validates that a string matches the `owner/repo` GitHub repository format.
 *
 * @param repo - String to validate
 * @returns    true if valid
 */
export function validateGitHubRepo(repo: string): boolean {
  return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo);
}

/**
 * Parses the KV namespace ID from `wrangler kv:namespace create` output.
 *
 * Example wrangler output:
 *   🌀 Creating namespace with title "worker-A3LIX_KV"
 *   { id: "abc123..." }
 *
 * @param wranglerOutput - Raw stdout/stderr from wrangler
 * @returns              Namespace ID string, or null if not found
 */
export function parseKvNamespaceId(wranglerOutput: string): string | null {
  const match = wranglerOutput.match(/"?id"?\s*:\s*"([a-f0-9]{32,})"/i);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function printBanner(): void {
  console.log('');
  console.log(chalk.blue('  ╔═══════════════════════════════╗'));
  console.log(
    chalk.blue('  ║') +
      chalk.bold('   A3lix — Site Update Agent   ') +
      chalk.blue('║')
  );
  console.log(
    chalk.blue('  ║') +
      chalk.dim('   npx a3lixcms@latest init    ') +
      chalk.blue('║')
  );
  console.log(chalk.blue('  ╚═══════════════════════════════╝'));
  console.log('');
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Reads and parses agent.json from the given directory.
 * Exits with a helpful error if the file is absent or invalid.
 */
function readAgentJson(cwd: string): AgentJson {
  const agentPath = join(cwd, 'agent.json');
  if (!existsSync(agentPath)) {
    console.error(chalk.red('❌  No agent.json found in the current directory.'));
    console.error(chalk.dim('   Run `npx a3lixcms init` first.'));
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(agentPath, 'utf-8')) as AgentJson;
  } catch {
    console.error(chalk.red('❌  Failed to parse agent.json — is it valid JSON?'));
    process.exit(1);
  }
  // unreachable — process.exit() above; satisfies TypeScript
  throw new Error('unreachable');
}

/** Reads wrangler.toml from cwd. Returns empty string if not present. */
function readWranglerToml(cwd: string): string {
  const tomlPath = join(cwd, 'wrangler.toml');
  return existsSync(tomlPath) ? readFileSync(tomlPath, 'utf-8') : '';
}

/** Extracts the `name` field value from a wrangler.toml string. */
function parseWorkerName(toml: string): string | null {
  return toml.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// `init` command — interactive wizard
// ---------------------------------------------------------------------------

/**
 * Main init wizard.
 * Asks the user a series of questions, writes config files, sets secrets,
 * bootstraps KV, deploys the worker, and prints the Telegram webhook command.
 */
async function runInit(): Promise<void> {
  printBanner();

  console.log(chalk.bold("Welcome! Let's set up your A3lix agent.\n"));
  console.log(
    chalk.dim("You'll be asked a few questions. Press Ctrl+C at any time to exit.\n")
  );

  // Pre-flight checklist
  console.log(chalk.yellow.bold('  Before you start, make sure you have:\n'));
  console.log(chalk.dim('  ✓ A GitHub repo for your site (e.g. username/my-site)'));
  console.log(
    chalk.dim(
      '  ✓ A GitHub Fine-grained PAT with Contents + Workflows read/write\n' +
        '    → Create one at: github.com/settings/tokens'
    )
  );
  console.log(
    chalk.dim(
      '  ✓ A Telegram bot token from @BotFather\n' +
        '    → Message @BotFather on Telegram, send /newbot'
    )
  );
  console.log(
    chalk.dim(
      '  ✓ Your Telegram User ID (send /start to @userinfobot to get it)'
    )
  );
  console.log(
    chalk.dim(
      '  ✓ A Cloudflare account with Workers and Pages enabled\n' +
        '    → dashboard.cloudflare.com → Workers & Pages'
    )
  );
  console.log(
    chalk.dim(
      '  ✓ wrangler authenticated: run `npx wrangler login` if you haven\'t yet\n'
    )
  );

  // We collect all answers here before the execution phase.
  let answers!: InitAnswers;

  try {
    // ------------------------------------------------------------------
    // Step 1 — Project setup
    // ------------------------------------------------------------------
    console.log(chalk.blue.bold('── Step 1: Project setup ──────────────────────────\n'));

    const step1 = await inquirer.prompt<{
      projectName: string;
      repo: string;
      branch: string;
      framework: string;
      pagesProjectName: string;
    }>([
      {
        type: 'input',
        name: 'projectName',
        message: "What's your project name?",
        validate: (v: string) =>
          v.trim().length > 0 || 'Project name is required.',
      },
      {
        type: 'input',
        name: 'repo',
        message: 'Your GitHub repo (format: username/repo)?',
        validate: (v: string) =>
          validateGitHubRepo(v.trim()) ||
          'Please enter a valid repo in the format owner/repo.',
      },
      {
        type: 'input',
        name: 'branch',
        message: 'Default branch?',
        default: 'main',
      },
      {
        type: 'rawlist',
        name: 'framework',
        message: 'Framework? (type a number)',
        choices: ['astro', 'nextjs'],
      },
      {
        type: 'input',
        name: 'pagesProjectName',
        message:
          'Cloudflare Pages project name?\n' +
          chalk.dim(
            '  (Found at: dashboard.cloudflare.com → Workers & Pages → Pages)\n  '
          ),
        default: (prev: { projectName: string }) => slugify(prev.projectName),
      },
    ]);

    // ------------------------------------------------------------------
    // Step 2 — Bot setup
    // ------------------------------------------------------------------
    console.log('\n' + chalk.blue.bold('── Step 2: Telegram bot setup ─────────────────────\n'));

    const step2 = await inquirer.prompt<{
      telegramBotToken: string;
      ownerChatId: string;
    }>([
      {
        type: 'password',
        name: 'telegramBotToken',
        message: 'Your Telegram Bot Token (from @BotFather)?',
        mask: '*',
        validate: (v: string) =>
          v.trim().length > 0 || 'Telegram Bot Token is required.',
      },
      {
        type: 'input',
        name: 'ownerChatId',
        message: 'Your Telegram Chat ID (owner)?\n' +
          chalk.dim('  (Send /start to @userinfobot to get your ID)\n  '),
        validate: (v: string) =>
          /^\d+$/.test(v.trim()) || 'Chat ID must be a numeric value.',
      },
    ]);

    // ------------------------------------------------------------------
    // Step 3 — AI setup
    // ------------------------------------------------------------------
    console.log('\n' + chalk.blue.bold('── Step 3: AI setup ───────────────────────────────\n'));

    const aiProviderChoices = [
      'workers-ai (default, no API key needed)',
      'openai',
      'claude',
      'grok',
      'groq',
      'gemini',
      'openrouter (access 300+ models, one API key)',
    ];

    const step3a = await inquirer.prompt<{ aiProviderRaw: string }>([
      {
        type: 'rawlist',
        name: 'aiProviderRaw',
        message: 'AI provider? (type a number)',
        choices: aiProviderChoices,
      },
    ]);

    // Normalise — strip everything after the first space (handles the parenthetical)
    const aiProvider = step3a.aiProviderRaw.split(' ')[0] as string;
    const defaultModel =
      DEFAULT_AI_MODELS[aiProvider] ?? DEFAULT_AI_MODELS['workers-ai'];

    const step3b = await inquirer.prompt<{ aiModel: string }>([
      {
        type: 'input',
        name: 'aiModel',
        message: 'AI model?',
        default: defaultModel,
      },
    ]);

    let aiApiKey: string | undefined;

    if (aiProvider !== 'workers-ai') {
      const step3c = await inquirer.prompt<{ aiApiKey: string }>([
        {
          type: 'password',
          name: 'aiApiKey',
          message: `API key for ${aiProvider}?`,
          mask: '*',
          validate: (v: string) =>
            v.trim().length > 0 ||
            `API key is required for provider "${aiProvider}".`,
        },
      ]);
      aiApiKey = step3c.aiApiKey;
    }

    // ------------------------------------------------------------------
    // Step 4 — GitHub PAT
    // ------------------------------------------------------------------
    console.log('\n' + chalk.blue.bold('── Step 4: GitHub token ───────────────────────────\n'));

    const step4 = await inquirer.prompt<{ githubToken: string }>([
      {
        type: 'password',
        name: 'githubToken',
        message:
          'GitHub Fine-grained PAT?\n' +
          chalk.dim(
            '  (github.com/settings/tokens — needs Contents read+write\n' +
              '   & Workflows read+write on your repo only)\n  '
          ),
        mask: '*',
        validate: (v: string) =>
          v.trim().length > 0 || 'GitHub PAT is required.',
      },
    ]);

    // ------------------------------------------------------------------
    // Step 5 — KV namespace
    // ------------------------------------------------------------------
    console.log('\n' + chalk.blue.bold('── Step 5: Cloudflare KV namespace ────────────────\n'));

    const step5 = await inquirer.prompt<{ kvNamespaceIdRaw: string }>([
      {
        type: 'input',
        name: 'kvNamespaceIdRaw',
        message:
          'Wrangler KV namespace ID (leave blank to auto-create)?\n' +
          chalk.dim(
            '  KV is a key-value store used to persist config and user roles.\n' +
              '  To find an existing ID: dashboard.cloudflare.com → Workers & Pages → KV\n  '
          ),
      },
    ]);

    let kvNamespaceId = step5.kvNamespaceIdRaw.trim();

    if (!kvNamespaceId) {
      const spinner = ora(
        'Creating KV namespace "A3LIX_KV" via wrangler…'
      ).start();
      const result = await runCommand('npx', [
        'wrangler',
        'kv:namespace',
        'create',
        'A3LIX_KV',
      ]);
      const combined = result.stdout + result.stderr;
      const parsed = parseKvNamespaceId(combined);

      if (parsed) {
        kvNamespaceId = parsed;
        spinner.succeed(
          `KV namespace created: ${chalk.green(kvNamespaceId)}`
        );
      } else {
        spinner.fail(
          'Could not parse KV namespace ID from wrangler output.'
        );
        console.log(chalk.dim('Wrangler output:\n') + combined);
        const fallback = await inquirer.prompt<{ kvId: string }>([
          {
            type: 'input',
            name: 'kvId',
            message: 'Please enter the KV namespace ID manually:',
            validate: (v: string) =>
              v.trim().length > 0 || 'KV namespace ID is required.',
          },
        ]);
        kvNamespaceId = fallback.kvId.trim();
      }
    }

    // ------------------------------------------------------------------
    // Step 6 — Webhook secret
    // ------------------------------------------------------------------
    console.log('\n' + chalk.blue.bold('── Step 6: Webhook security ───────────────────────\n'));

    const step6 = await inquirer.prompt<{ webhookSecretRaw: string }>([
      {
        type: 'input',
        name: 'webhookSecretRaw',
        message:
          'Telegram webhook secret (leave blank to auto-generate)?',
      },
    ]);

    const webhookSecret =
      step6.webhookSecretRaw.trim() || generateSecret(32);

    // ------------------------------------------------------------------
    // Aggregate
    // ------------------------------------------------------------------
    answers = {
      projectName: step1.projectName.trim(),
      repo: step1.repo.trim(),
      branch: step1.branch.trim(),
      framework: step1.framework,
      pagesProjectName: step1.pagesProjectName.trim(),
      telegramBotToken: step2.telegramBotToken.trim(),
      ownerChatId: step2.ownerChatId.trim(),
      aiProvider,
      aiModel: step3b.aiModel.trim(),
      aiApiKey,
      githubToken: step4.githubToken.trim(),
      kvNamespaceId,
      webhookSecret,
    };
  } catch (err: unknown) {
    const errMsg =
      err instanceof Error ? err.message : '';
    if (errMsg.includes('force closed') || errMsg.includes('User force closed')) {
      console.log('\n' + chalk.yellow('Setup cancelled.'));
    } else {
      console.error('\n' + chalk.red('An error occurred during setup:'), err);
    }
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(
    '\n' +
      chalk.bold(
        '─────────────────────────────────────────────────────'
      )
  );
  console.log(chalk.bold('  Summary of what will be created:'));
  console.log(
    chalk.bold(
      '─────────────────────────────────────────────────────'
    )
  );
  console.log(
    `  Project  : ${chalk.green(answers.projectName)} (${answers.repo})`
  );
  console.log(`  Branch   : ${answers.branch}`);
  console.log(`  Framework: ${answers.framework}`);
  console.log(`  Pages    : ${answers.pagesProjectName}`);
  console.log(`  Owner ID : ${answers.ownerChatId}`);
  console.log(`  AI       : ${answers.aiProvider} / ${answers.aiModel}`);
  console.log(`  KV ID    : ${answers.kvNamespaceId}`);
  console.log(
    chalk.bold(
      '─────────────────────────────────────────────────────\n'
    )
  );

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Proceed with setup?',
      default: true,
    },
  ]);

  if (!confirmed) {
    console.log(chalk.yellow('Setup cancelled.'));
    process.exit(0);
  }

  const cwd = process.cwd();

  // -----------------------------------------------------------------------
  // [1/7] Write agent.json
  // -----------------------------------------------------------------------
  {
    const spinner = ora(chalk.blue('[1/7] 📝 Writing agent.json…')).start();

    const agentJson: AgentJson = {
      project: {
        name: answers.projectName,
        repo: answers.repo,
        branch: answers.branch,
        framework: answers.framework,
      },
      bot: {
        platform: 'telegram',
        ownerChatId: answers.ownerChatId,
      },
      ai: {
        provider: answers.aiProvider,
        model: answers.aiModel,
      },
      paths: {
        allowed: [
          'src/content',
          'src/components',
          'src/pages',
          'public',
          'tailwind.config.*',
        ],
      },
      roles: {
        editors: [],
        viewers: [],
      },
      limits: {
        changesPerUserPerDay: 5,
        previewExpiryHours: 24,
        requireApprovalForAll: true,
      },
      cloudflare: {
        pagesProjectName: answers.pagesProjectName,
      },
    };

    try {
      writeFileSync(
        join(cwd, 'agent.json'),
        JSON.stringify(agentJson, null, 2) + '\n',
        'utf-8'
      );
      spinner.succeed(chalk.green('[1/7] ✅ agent.json written.'));
    } catch (err) {
      spinner.fail(chalk.red('[1/7] Failed to write agent.json.'));
      console.error(err);
      process.exit(1);
    }
  }

  // -----------------------------------------------------------------------
  // [2/7] Write wrangler.toml
  // -----------------------------------------------------------------------
  {
    const spinner = ora(chalk.blue('[2/7] 📝 Writing wrangler.toml…')).start();

    const wranglerToml = [
      `name = "a3lix-worker"`,
      `main = "./node_modules/a3lixcms/worker/src/index.ts"`,
      `compatibility_date = "2024-05-29"`,
      `compatibility_flags = ["nodejs_compat"]`,
      ``,
      `[ai]`,
      `binding = "AI"`,
      ``,
      `[[kv_namespaces]]`,
      `binding = "A3LIX_KV"`,
      `id = "${answers.kvNamespaceId}"`,
      `preview_id = "${answers.kvNamespaceId}"`,
      ``,
      `[[r2_buckets]]`,
      `binding = "A3LIX_R2"`,
      `bucket_name = "a3lix-images"`,
      ``,
      `[vars]`,
      `ENVIRONMENT = "production"`,
      `LOG_LEVEL = "info"`,
      ``,
    ].join('\n');

    try {
      writeFileSync(join(cwd, 'wrangler.toml'), wranglerToml, 'utf-8');
      spinner.succeed(chalk.green('[2/7] ✅ wrangler.toml written.'));
    } catch (err) {
      spinner.fail(chalk.red('[2/7] Failed to write wrangler.toml.'));
      console.error(err);
      process.exit(1);
    }
  }

  // Ensure agent.json is in .gitignore
  {
    const gitignorePath = join(cwd, '.gitignore');
    const existing = existsSync(gitignorePath)
      ? readFileSync(gitignorePath, 'utf-8')
      : '';
    if (!existing.includes('agent.json')) {
      appendFileSync(
        gitignorePath,
        '\n# A3lix — never commit local config or secrets\nagent.json\n.dev.vars\n',
        'utf-8'
      );
      console.log(
        chalk.dim(
          '  ↳ Added agent.json and .dev.vars to .gitignore'
        )
      );
    }
  }

  // -----------------------------------------------------------------------
  // [3/7] Set wrangler secrets
  // -----------------------------------------------------------------------
  {
    const spinner = ora(
      chalk.blue('[3/7] 🔒 Setting secrets via `wrangler secret put`…')
    ).start();

    const secrets: Array<{ name: string; value: string }> = [
      { name: 'GITHUB_TOKEN', value: answers.githubToken },
      { name: 'TELEGRAM_BOT_TOKEN', value: answers.telegramBotToken },
      { name: 'TELEGRAM_SECRET_TOKEN', value: answers.webhookSecret },
    ];

    if (answers.aiProvider !== 'workers-ai' && answers.aiApiKey) {
      secrets.push({ name: 'AI_API_KEY', value: answers.aiApiKey });
    }

    let allSecretsOk = true;

    for (const secret of secrets) {
      spinner.text = chalk.blue(
        `[3/7] 🔒 Setting secret: ${secret.name}…`
      );
      const result = await runCommand(
        'npx',
        ['wrangler', 'secret', 'put', secret.name],
        { input: secret.value + '\n' }
      );
      if (result.exitCode !== 0) {
        console.log(
          '\n' + chalk.red(`  ✗ Failed to set ${secret.name}:`)
        );
        console.log(chalk.dim(result.stderr));
        allSecretsOk = false;
      } else {
        console.log(chalk.dim(`\n  ✓ ${secret.name}`));
      }
    }

    if (answers.aiProvider === 'workers-ai') {
      console.log(chalk.dim('  ↳ AI_API_KEY skipped (workers-ai)'));
    }

    if (allSecretsOk) {
      spinner.succeed(chalk.green('[3/7] ✅ Secrets set.'));
    } else {
      spinner.warn(
        chalk.yellow(
          '[3/7] ⚠️  Some secrets failed — run `wrangler secret put <NAME>` manually.'
        )
      );
    }
  }

  // -----------------------------------------------------------------------
  // [4/7] Bootstrap KV
  // -----------------------------------------------------------------------
  {
    const spinner = ora(
      chalk.blue('[4/7] 🔑 Bootstrapping KV namespace…')
    ).start();

    const { kvNamespaceId, ownerChatId, aiProvider, aiModel } = answers;

    const agentConfigForKv = {
      project: {
        name: answers.projectName,
        repo: answers.repo,
        branch: answers.branch,
        framework: answers.framework,
      },
      ai: { provider: aiProvider, model: aiModel },
      limits: {
        changesPerUserPerDay: 5,
        previewExpiryHours: 24,
        requireApprovalForAll: true,
      },
      cloudflare: { pagesProjectName: answers.pagesProjectName },
    };

    const userRecord: UserRecord = {
      chatId: ownerChatId,
      role: 'owner',
      addedAt: new Date().toISOString(),
      addedBy: 'cli',
    };

    const kvPuts: Array<[string, string]> = [
      ['config', JSON.stringify(agentConfigForKv)],
      [`role:${ownerChatId}`, 'owner'],
      [`user:${ownerChatId}`, JSON.stringify(userRecord)],
    ];

    let allKvOk = true;

    for (const [key, value] of kvPuts) {
      spinner.text = chalk.blue(`[4/7] 🔑 Writing KV key: ${key}…`);
      const result = await runCommand('npx', [
        'wrangler',
        'kv:key',
        'put',
        `--namespace-id=${kvNamespaceId}`,
        key,
        value,
      ]);
      if (result.exitCode !== 0) {
        console.log(
          '\n' + chalk.red(`  ✗ Failed to write KV key "${key}":`)
        );
        console.log(chalk.dim(result.stderr));
        allKvOk = false;
      } else {
        console.log(chalk.dim(`\n  ✓ ${key}`));
      }
    }

    if (allKvOk) {
      spinner.succeed(chalk.green('[4/7] ✅ KV bootstrapped.'));
    } else {
      spinner.warn(
        chalk.yellow(
          '[4/7] ⚠️  Some KV writes failed — check wrangler permissions.'
        )
      );
    }
  }

  // -----------------------------------------------------------------------
  // [5/7] Deploy worker
  // -----------------------------------------------------------------------
  {
    const spinner = ora(
      chalk.blue('[5/7] 🚀 Deploying worker via `wrangler deploy`…')
    ).start();

    const result = await runCommand('npx', ['wrangler', 'deploy']);

    if (result.exitCode !== 0) {
      spinner.fail(chalk.red('[5/7] ❌ Deployment failed.'));
      console.log(chalk.dim(result.stderr));
      console.log(
        chalk.yellow(
          '  Re-run `npx wrangler deploy` once the issues above are resolved.'
        )
      );
    } else {
      spinner.succeed(chalk.green('[5/7] ✅ Worker deployed.'));
      if (result.stdout.trim()) {
        console.log(chalk.dim(result.stdout.trim()));
      }
    }
  }

  // -----------------------------------------------------------------------
  // [6/7] Telegram webhook
  // -----------------------------------------------------------------------
  {
    console.log(chalk.blue('\n[6/7] 🔗 Telegram webhook setup\n'));
    console.log(
      chalk.dim(
        '  Set your webhook by running the following curl command:\n'
      )
    );
    console.log(
      chalk.bold(
        `  curl -X POST https://api.telegram.org/bot${answers.telegramBotToken}/setWebhook \\`
      )
    );
    console.log(
      chalk.bold(
        '    -d "url=https://a3lix-worker.<YOUR_SUBDOMAIN>.workers.dev/telegram" \\'
      )
    );
    console.log(
      chalk.bold(`    -d "secret_token=${answers.webhookSecret}"`)
    );
    console.log(
      '\n' +
        chalk.dim(
          '  Replace <YOUR_SUBDOMAIN> with your Cloudflare workers.dev subdomain.\n' +
            '  Find it at: dashboard.cloudflare.com → Workers & Pages → Overview\n' +
            '  It appears in the URL of any deployed worker, e.g.\n' +
            '  https://a3lix-worker.MY-ACCOUNT.workers.dev'
        )
    );
    console.log(
      '\n' +
        chalk.blue(
          '[6/7] 📋 Webhook command printed above — run it once you know your account subdomain.'
        )
    );
  }

  // -----------------------------------------------------------------------
  // [7/7] Done
  // -----------------------------------------------------------------------
  console.log('');
  console.log(chalk.green.bold('[7/7] ✅ A3lix setup complete!\n'));
  console.log(chalk.bold("  What's next:"));
  console.log(chalk.dim('  1. Run the webhook curl command above.'));
  console.log(chalk.dim('  2. Send /help to your bot on Telegram.'));
  console.log(chalk.dim('  3. Make your first content change!\n'));
}

// ---------------------------------------------------------------------------
// `update` command
// ---------------------------------------------------------------------------

/** Files that must never be overwritten during an update. */
const PROTECTED_FILES = ['agent.json', '.dev.vars', '.env'] as const;

/**
 * Smart update: installs the latest a3lix package, verifies protected files
 * were not touched, then re-deploys the worker.
 */
async function runUpdate(): Promise<void> {
  const cwd = process.cwd();

  const agentPath = join(cwd, 'agent.json');
  if (!existsSync(agentPath)) {
    console.error(chalk.red('❌  No agent.json found.'));
    console.error(chalk.dim('   Run `npx a3lixcms init` first.'));
    process.exit(1);
  }

  // Snapshot agent.json before updating the package
  const previousAgentJson = readFileSync(agentPath, 'utf-8');

  // Step 1 — Install latest
  {
    const spinner = ora('Checking for updates…').start();
    const result = await runCommand('npm', ['install', 'a3lixcms@latest']);
    if (result.exitCode !== 0) {
      spinner.fail(chalk.red('Failed to install a3lixcms@latest.'));
      console.error(chalk.dim(result.stderr));
      process.exit(1);
    }
    spinner.succeed(chalk.green('a3lixcms@latest installed.'));
  }

  // Step 2 — Verify / restore protected files
  {
    const spinner = ora('Verifying protected files…').start();

    for (const file of PROTECTED_FILES) {
      const filePath = join(cwd, file);
      if (file === 'agent.json' && existsSync(filePath)) {
        const currentContent = readFileSync(filePath, 'utf-8');
        if (currentContent !== previousAgentJson) {
          spinner.warn(
            chalk.yellow(
              `⚠️  agent.json changed during update — restoring backup…`
            )
          );
          writeFileSync(filePath, previousAgentJson, 'utf-8');
        }
      }
    }

    spinner.succeed(chalk.green('Protected files verified.'));
  }

  // Step 3 — Re-deploy
  {
    const spinner = ora('Re-deploying worker with new code…').start();
    const result = await runCommand('npx', ['wrangler', 'deploy']);
    if (result.exitCode !== 0) {
      spinner.fail(chalk.red('Deployment failed.'));
      console.error(chalk.dim(result.stderr));
      process.exit(1);
    }
    spinner.succeed(chalk.green('Worker deployed.'));
  }

  console.log('');
  console.log(
    chalk.green.bold(
      '✅ A3lix updated successfully! Your agent.json and secrets were preserved.'
    )
  );
}

// ---------------------------------------------------------------------------
// `status` command
// ---------------------------------------------------------------------------

/**
 * Quick health check — verifies the worker is deployed and reachable,
 * then prints a summary of the current project config.
 */
async function runStatus(): Promise<void> {
  const cwd = process.cwd();
  const agentJson = readAgentJson(cwd);
  const wranglerToml = readWranglerToml(cwd);
  const workerName = parseWorkerName(wranglerToml) ?? 'a3lix-worker';

  console.log('');
  console.log(chalk.bold('A3lix Status'));
  console.log(
    chalk.dim('─────────────────────────────────────────────────────')
  );
  console.log(`  Project   : ${chalk.green(agentJson.project.name)}`);
  console.log(
    `  Repo      : ${agentJson.project.repo} (${agentJson.project.branch})`
  );
  console.log(`  Framework : ${agentJson.project.framework}`);
  console.log(`  AI        : ${agentJson.ai.provider} / ${agentJson.ai.model}`);
  console.log(`  Pages     : ${agentJson.cloudflare.pagesProjectName}`);
  console.log(`  Worker    : ${workerName}`);
  console.log('');

  const workerUrl = `https://${workerName}.workers.dev/health`;
  const spinner = ora(`Checking ${chalk.dim(workerUrl)} …`).start();

  try {
    const response = await fetch(workerUrl, { method: 'GET' });
    if (response.ok) {
      spinner.succeed(
        chalk.green(`✅ Worker is responding (HTTP ${response.status}).`)
      );
    } else {
      spinner.warn(
        chalk.yellow(
          `⚠️  Worker returned HTTP ${response.status} — may be misconfigured.`
        )
      );
    }
  } catch {
    spinner.fail(
      chalk.red(
        `❌ Worker not reachable at ${workerUrl}\n` +
          chalk.dim(
            '   Check that the worker is deployed and the subdomain is correct.'
          )
      )
    );
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// `whoami` command
// ---------------------------------------------------------------------------

/**
 * Prints the current A3lix configuration without revealing any secrets.
 */
async function runWhoami(): Promise<void> {
  const cwd = process.cwd();
  const agentJson = readAgentJson(cwd);

  console.log('');
  console.log(chalk.bold('A3lix — Current Configuration'));
  console.log(
    chalk.dim('─────────────────────────────────────────────────────')
  );
  console.log(
    `  Project      : ${chalk.green(agentJson.project.name)} ` +
      `(${agentJson.project.repo}, ${agentJson.project.framework})`
  );
  console.log(
    `  AI           : ${agentJson.ai.provider} (${agentJson.ai.model})`
  );
  console.log(`  Owner Chat ID: ${agentJson.bot.ownerChatId}`);
  console.log(
    `  Pages Project: ${agentJson.cloudflare.pagesProjectName}`
  );
  console.log(
    `  Rate limit   : ${agentJson.limits.changesPerUserPerDay} changes/user/day`
  );
  console.log(chalk.dim('\n  [API keys and tokens are not shown]'));
  console.log('');
}

// ---------------------------------------------------------------------------
// Commander program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('a3lixcms')
  .version('0.1.0')
  .description(
    'A3lix — the open-source Cloudflare Workers + AI site update agent'
  );

program
  .command('init')
  .description(
    'Interactive setup wizard — creates all config files and deploys the worker'
  )
  .action(async () => {
    try {
      await runInit();
    } catch (err) {
      console.error(chalk.red('\n❌ An unexpected error occurred:'), err);
      process.exit(1);
    }
  });

program
  .command('update')
  .description(
    'Smart update — pulls the latest a3lix package and re-deploys, preserving your config'
  )
  .action(async () => {
    try {
      await runUpdate();
    } catch (err) {
      console.error(chalk.red('\n❌ Update failed:'), err);
      process.exit(1);
    }
  });

program
  .command('status')
  .description(
    'Quick health check — verifies the worker is deployed and reachable'
  )
  .action(async () => {
    try {
      await runStatus();
    } catch (err) {
      console.error(chalk.red('\n❌ Status check failed:'), err);
      process.exit(1);
    }
  });

program
  .command('whoami')
  .description(
    'Show current config (project, repo, AI provider) without revealing secrets'
  )
  .action(async () => {
    try {
      await runWhoami();
    } catch (err) {
      console.error(chalk.red('\n❌ Could not read config:'), err);
      process.exit(1);
    }
  });

program.addHelpText(
  'after',
  `
${chalk.dim('Examples:')}
  ${chalk.green('npx a3lixcms@latest init')}     Set up a new A3lix agent in this directory
  ${chalk.green('npx a3lixcms update')}          Update to the latest A3lix version
  ${chalk.green('npx a3lixcms status')}          Check worker health
  ${chalk.green('npx a3lixcms whoami')}          Show current config
`
);

// Must be the last statement — async because all commands are async
program.parseAsync(process.argv);
