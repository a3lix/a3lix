/// <reference types="@cloudflare/workers-types" />

/**
 * @module parser
 *
 * The 2-step AI parsing brain of A3lix.
 *
 * Takes a raw Telegram message and produces structured file-change instructions
 * using a two-pass AI approach:
 *
 *   Step 1 — Classifier  (`classifyIntent`):
 *     Determines WHAT the user wants (intent) without generating any code.
 *     Cheap, fast, safe. Returns a structured {@link ParsedIntent} object.
 *
 *   Step 2 — Code Generator (`generateFileChanges`):
 *     Takes the classified intent + original message and generates actual file
 *     content. Only runs if Step 1 returns a valid, allowed intent.
 *
 * This split exists because:
 *   - A single "classify + generate" prompt is unreliable and leaks context
 *   - Step 1 can be run on a smaller/faster model
 *   - Step 2 can be aborted early if intent is disallowed
 *
 * AI provider routing is handled by {@link callAi}, which supports:
 *   workers-ai, openai, claude, grok, groq, gemini, openrouter
 */

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/**
 * Supported AI provider identifiers.
 * Corresponds to the `provider` field in `agent.json`.
 */
export type AiProvider = 'workers-ai' | 'openai' | 'claude' | 'grok' | 'groq' | 'gemini' | 'openrouter';

/**
 * Configuration for the AI provider, sourced from `agent.json`.
 */
export interface AiConfig {
  /** The AI provider to use for inference. */
  provider: AiProvider;
  /** The model identifier (e.g. `@cf/meta/llama-3-8b-instruct`, `gpt-4o`). */
  model: string;
  /**
   * API key for the provider.
   * Not required for `workers-ai` (uses the `AI` binding directly).
   */
  apiKey?: string;
}

/**
 * The classified intent types the agent can recognise.
 *
 * - `new_blog_post`    — User wants to create a new blog post entry.
 * - `new_page`         — User wants to create an entirely new page.
 * - `edit_text`        — User wants to change text on an existing page.
 * - `edit_colors`      — User wants to update colour values (Tailwind config).
 * - `edit_component`   — User wants to change a specific reusable component.
 * - `edit_footer`      — User wants to edit the site footer specifically.
 * - `edit_hero`        — User wants to edit the hero/banner section.
 * - `multi_file_edit`  — User described changes to multiple areas at once.
 * - `status_check`     — Viewer-safe: "what's deployed?", "what changed?".
 * - `unknown`          — Could not classify with sufficient confidence.
 */
export type IntentType =
  | 'new_blog_post'
  | 'new_page'
  | 'edit_text'
  | 'edit_colors'
  | 'edit_component'
  | 'edit_footer'
  | 'edit_hero'
  | 'multi_file_edit'
  | 'status_check'
  | 'unknown';

/**
 * The result of Step 1 (intent classification).
 * Contains everything needed to decide whether to proceed to Step 2.
 */
export interface ParsedIntent {
  /** The classified intent type. */
  type: IntentType;
  /** How confident the classifier is in its classification. */
  confidence: 'high' | 'medium' | 'low';
  /**
   * Best-guess affected file paths from the classifier.
   * May be empty; will be refined or replaced in Step 2.
   */
  affectedPaths: string[];
  /**
   * Extracted key-value metadata (title, slug, color, section, author, etc.).
   * All values are strings for simplicity and JSON compatibility.
   */
  metadata: Record<string, string>;
  /**
   * Whether this intent requires actual file mutations.
   * `false` for `status_check` and `unknown` — no code generation needed.
   */
  requiresFileChanges: boolean;
}

/**
 * A single file change produced by the code generator (Step 2).
 */
export interface FileChange {
  /** Repo-relative file path, e.g. `src/content/blog/my-post.md`. */
  path: string;
  /** Complete file content as a UTF-8 string. Never partial. */
  content: string;
  /** The mutation type. `delete` is intentionally excluded from generation. */
  operation: 'create' | 'update';
}

/**
 * The full result returned by {@link parse} to the caller.
 * Contains both the classified intent and all generated file changes.
 */
export interface ParseResult {
  /** The classified intent from Step 1. */
  intent: ParsedIntent;
  /** The file changes generated in Step 2. Empty array if no changes needed. */
  changes: FileChange[];
  /**
   * Human-readable summary of what will be done, shown to the user before
   * they confirm. E.g. "I'll create a new blog post at src/content/blog/…"
   */
  summary: string;
  /**
   * Optional clarification questions from the AI, surfaced when confidence
   * is `'low'`. Asking these helps the user refine their request.
   */
  clarifications?: string[];
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Provider base URLs for HTTP-based AI providers.
 * `workers-ai` is handled via the AI binding, not HTTP.
 * @internal
 */
const PROVIDER_URLS: Record<Exclude<AiProvider, 'workers-ai'>, string> = {
  openai:      'https://api.openai.com/v1/chat/completions',
  grok:        'https://api.x.ai/v1/chat/completions',
  groq:        'https://api.groq.com/openai/v1/chat/completions',
  claude:      'https://api.anthropic.com/v1/messages',
  gemini:      'https://generativelanguage.googleapis.com/v1beta/models',
  openrouter:  'https://openrouter.ai/api/v1/chat/completions',
};

/**
 * Hardcoded clarification questions per intent type.
 * These are surfaced when Step 1 returns `confidence: 'low'`.
 * They are NOT AI-generated — deterministic and safe.
 * @internal
 */
const CLARIFICATION_QUESTIONS: Partial<Record<IntentType, string[]>> = {
  new_blog_post: [
    "What should the blog post title be?",
    "Do you have a specific publish date in mind, or should I use today's date?",
    "Should this be published immediately (draft: false) or saved as a draft?",
  ],
  new_page: [
    "What should the page URL/slug be? (e.g., /about-us)",
    "What sections should the page include?",
  ],
  edit_colors: [
    "Which specific color would you like to change? (e.g., primary button, background, headings)",
    "Do you have a specific hex color code, or a description like 'navy blue'?",
  ],
  edit_text: [
    "Which section of the page should be updated?",
    "Should I keep the existing formatting and structure?",
  ],
  multi_file_edit: [
    "Can you list each change separately? I want to make sure I get everything right.",
  ],
};

/**
 * The classifier system prompt used in Step 1.
 * @internal
 */
const CLASSIFIER_SYSTEM_PROMPT =
  `You are a precise intent classifier for a website update agent. \
Analyze the user's message and return ONLY valid JSON matching this schema — no markdown, no explanation:
{
  "type": one of: new_blog_post|new_page|edit_text|edit_colors|edit_component|edit_footer|edit_hero|multi_file_edit|status_check|unknown,
  "confidence": "high"|"medium"|"low",
  "affectedPaths": [array of likely file paths, can be empty],
  "metadata": {object of key-value strings extracted from the message},
  "requiresFileChanges": true|false
}

Rules:
- status_check is for questions like "what's live?" or "what changed last week?" — no file changes
- multi_file_edit when user says "also" or lists multiple sections to change
- If you cannot classify with at least low confidence, return type: "unknown"
- affectedPaths should use paths like "src/content/blog/slug.md" or "src/components/Footer.astro"
- metadata should extract: title, slug, targetComponent, color, text, section, author
- NEVER include any explanation outside the JSON object`;

/**
 * Builds the code-generator system prompt used in Step 2.
 * Inlined as a function so the framework name can be interpolated at call time.
 * @internal
 */
function buildGeneratorSystemPrompt(framework: 'astro' | 'nextjs'): string {
  return `You are an expert ${framework} developer making precise, minimal file changes to a client website.
You MUST return ONLY a JSON array of file change objects — no markdown fences, no explanation:
[
  {
    "path": "relative/path/from/repo/root",
    "content": "complete file content as a string",
    "operation": "create"|"update"
  }
]

Critical rules:
- Return ONLY the JSON array, starting with [ and ending with ]
- Every "content" field must be the COMPLETE file content (never partial)
- For Markdown/MDX blog posts: include proper frontmatter (title, date, author, draft: false)
- For Astro pages: use proper Astro component syntax with frontmatter
- For Next.js pages: use TypeScript React with proper exports
- Respect the detected framework: ${framework}
- Only use paths within: src/content, src/components, src/pages, public, tailwind.config.*
- Generate clean, production-quality code with no placeholder comments
- If making color changes, update tailwind.config.ts/mjs — never inline styles
- NEVER include process.env, eval, require('child_process'), or any secret references`;
}

// ---------------------------------------------------------------------------
// Safe fallback values
// ---------------------------------------------------------------------------

/**
 * Returned by {@link classifyIntent} whenever Step 1 JSON parsing fails.
 * @internal
 */
const FALLBACK_INTENT: ParsedIntent = {
  type: 'unknown',
  confidence: 'low',
  affectedPaths: [],
  metadata: {},
  requiresFileChanges: false,
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Narrows an `unknown` value to a valid {@link ParsedIntent} shape.
 * @internal
 */
function isParsedIntent(value: unknown): value is ParsedIntent {
  if (typeof value !== 'object' || value === null) return false;

  const v = value as Record<string, unknown>;

  const validTypes: IntentType[] = [
    'new_blog_post', 'new_page', 'edit_text', 'edit_colors',
    'edit_component', 'edit_footer', 'edit_hero', 'multi_file_edit',
    'status_check', 'unknown',
  ];
  if (!validTypes.includes(v['type'] as IntentType)) return false;

  if (v['confidence'] !== 'high' && v['confidence'] !== 'medium' && v['confidence'] !== 'low') {
    return false;
  }

  if (!Array.isArray(v['affectedPaths'])) return false;
  if (typeof v['metadata'] !== 'object' || v['metadata'] === null) return false;
  if (typeof v['requiresFileChanges'] !== 'boolean') return false;

  return true;
}

/**
 * Narrows an `unknown` value to a valid {@link FileChange} shape.
 * @internal
 */
function isFileChange(value: unknown): value is FileChange {
  if (typeof value !== 'object' || value === null) return false;

  const v = value as Record<string, unknown>;

  if (typeof v['path'] !== 'string' || v['path'].trim() === '') return false;
  if (typeof v['content'] !== 'string') return false;
  if (v['operation'] !== 'create' && v['operation'] !== 'update') return false;

  return true;
}

// ---------------------------------------------------------------------------
// HTTP provider helpers
// ---------------------------------------------------------------------------

/**
 * Calls an OpenAI-compatible API (openai, grok, groq, openrouter).
 * @internal
 */
async function callOpenAiCompatible(
  url: string,
  apiKey: string,
  model: string,
  system: string,
  user: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI provider request failed (${url}): HTTP ${response.status}`);
  }

  const data = await response.json() as unknown;
  const d = data as Record<string, unknown>;
  const choices = d['choices'] as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];

  if (typeof content !== 'string') {
    throw new Error(`AI provider (${url}) returned unexpected response shape`);
  }

  return content;
}

/**
 * Calls the Anthropic Claude API.
 * @internal
 */
async function callClaude(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const url = PROVIDER_URLS.claude;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API request failed: HTTP ${response.status}`);
  }

  const data = await response.json() as unknown;
  const d = data as Record<string, unknown>;
  const contentArr = d['content'] as Array<Record<string, unknown>> | undefined;
  const text = contentArr?.[0]?.['text'];

  if (typeof text !== 'string') {
    throw new Error('Claude API returned unexpected response shape');
  }

  return text;
}

/**
 * Calls the Google Gemini API.
 * @internal
 */
async function callGemini(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const url = `${PROVIDER_URLS.gemini}/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { parts: [{ text: user }] },
      ],
      systemInstruction: {
        parts: [{ text: system }],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini API request failed: HTTP ${response.status}`);
  }

  const data = await response.json() as unknown;
  const d = data as Record<string, unknown>;
  const candidates = d['candidates'] as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.['content'] as Record<string, unknown> | undefined;
  const parts = content?.['parts'] as Array<Record<string, unknown>> | undefined;
  const text = parts?.[0]?.['text'];

  if (typeof text !== 'string') {
    throw new Error('Gemini API returned unexpected response shape');
  }

  return text;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Routes an AI prompt to the correct provider and returns the raw text
 * response. Supports all six providers declared in `AiProvider`.
 *
 * Provider routing:
 *   - `workers-ai` → `aiBinding.run()` (no HTTP, uses Cloudflare AI binding)
 *   - `openai` / `grok` / `groq` / `openrouter` → OpenAI-compatible chat completions API
 *   - `claude` → Anthropic Messages API
 *   - `gemini` → Google Generative Language API
 *
 * @param prompt    - Object containing `system` and `user` prompt strings.
 * @param aiConfig  - Provider config (provider, model, apiKey).
 * @param aiBinding - Cloudflare `Ai` binding (required for `workers-ai`; ignored otherwise).
 * @returns Raw text response from the AI provider.
 * @throws `Error` with the provider name and HTTP status on any network or API error.
 */
export async function callAi(
  prompt: { system: string; user: string },
  aiConfig: AiConfig,
  aiBinding: Ai,
): Promise<string> {
  const { system, user } = prompt;
  const { provider, model, apiKey } = aiConfig;

  switch (provider) {
    case 'workers-ai': {
      // Cast to handle Workers AI union return type safely.
      const result = await aiBinding.run(
        model as Parameters<Ai['run']>[0],
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user',   content: user   },
          ],
        },
      ) as { response?: string };

      return result.response ?? '';
    }

    case 'openai':
    case 'grok':
    case 'groq':
    case 'openrouter': {
      if (!apiKey) {
        throw new Error(`Provider "${provider}" requires an apiKey in AiConfig`);
      }
      const extraHeaders = provider === 'openrouter'
        ? { 'HTTP-Referer': 'https://a3lix.com', 'X-Title': 'A3lix' }
        : {};
      return callOpenAiCompatible(PROVIDER_URLS[provider], apiKey, model, system, user, extraHeaders);
    }

    case 'claude': {
      if (!apiKey) {
        throw new Error(`Provider "claude" requires an apiKey in AiConfig`);
      }
      return callClaude(apiKey, model, system, user);
    }

    case 'gemini': {
      if (!apiKey) {
        throw new Error(`Provider "gemini" requires an apiKey in AiConfig`);
      }
      return callGemini(apiKey, model, system, user);
    }

    default: {
      // TypeScript exhaustiveness guard — should never reach here at runtime.
      const _exhaustive: never = provider;
      throw new Error(`Unknown AI provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * **Step 1 — Intent Classifier**
 *
 * Sends the user message to the AI with a strict classifier prompt.
 * Returns a structured {@link ParsedIntent} without generating any code.
 *
 * On JSON parse failure or invalid response shape, returns a safe fallback:
 * `{ type: 'unknown', confidence: 'low', affectedPaths: [], metadata: {}, requiresFileChanges: false }`
 *
 * @param message   - The raw message text from the Telegram user.
 * @param aiConfig  - Provider config (provider, model, apiKey).
 * @param aiBinding - Cloudflare `Ai` binding (used when provider is `workers-ai`).
 * @returns A classified {@link ParsedIntent}.
 */
export async function classifyIntent(
  message: string,
  aiConfig: AiConfig,
  aiBinding: Ai,
): Promise<ParsedIntent> {
  let rawResponse: string;

  try {
    rawResponse = await callAi(
      { system: CLASSIFIER_SYSTEM_PROMPT, user: message },
      aiConfig,
      aiBinding,
    );
  } catch {
    return { ...FALLBACK_INTENT };
  }

  try {
    const parsed: unknown = JSON.parse(rawResponse.trim());
    if (isParsedIntent(parsed)) {
      return parsed;
    }
    return { ...FALLBACK_INTENT };
  } catch {
    return { ...FALLBACK_INTENT };
  }
}

/**
 * **Step 2 — Code Generator**
 *
 * Sends the original message + classified intent to the AI with a code-gen
 * prompt. Returns an array of {@link FileChange} objects representing actual
 * file mutations.
 *
 * On JSON parse failure, returns an empty array `[]`.
 * Items missing required fields (`path`, `content`, `operation`) are filtered out.
 *
 * @param message   - The original raw message text from the Telegram user.
 * @param intent    - The {@link ParsedIntent} produced by {@link classifyIntent}.
 * @param framework - The target site framework (`'astro'` or `'nextjs'`).
 * @param aiConfig  - Provider config (provider, model, apiKey).
 * @param aiBinding - Cloudflare `Ai` binding (used when provider is `workers-ai`).
 * @returns An array of validated {@link FileChange} objects.
 */
export async function generateFileChanges(
  message: string,
  intent: ParsedIntent,
  framework: 'astro' | 'nextjs',
  aiConfig: AiConfig,
  aiBinding: Ai,
): Promise<FileChange[]> {
  const systemPrompt = buildGeneratorSystemPrompt(framework);

  const userPrompt =
    `User request: ${message}\n\nClassified intent: ${JSON.stringify(intent, null, 2)}`;

  let rawResponse: string;

  try {
    rawResponse = await callAi(
      { system: systemPrompt, user: userPrompt },
      aiConfig,
      aiBinding,
    );
  } catch {
    return [];
  }

  try {
    const trimmed = rawResponse.trim();
    const parsed: unknown = JSON.parse(trimmed);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isFileChange);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/**
 * Builds the human-readable `summary` string shown to the user before they
 * confirm or reject a proposed change-set.
 * @internal
 */
function buildSummary(intent: ParsedIntent, changes: FileChange[]): string {
  switch (intent.type) {
    case 'new_blog_post':
      return `I'll create a new blog post: '${changes[0]?.path ?? 'new post'}'. Ready to preview?`;

    case 'new_page':
      return `I'll create a new page at ${changes[0]?.path ?? 'new page'}. Ready to preview?`;

    case 'edit_text':
    case 'edit_colors':
    case 'edit_component':
    case 'edit_footer':
    case 'edit_hero':
    case 'multi_file_edit':
      return `I'll update ${changes.length} file(s): ${changes.map((c) => c.path).join(', ')}. Ready to preview?`;

    case 'unknown':
      return (
        "I didn't quite understand that. Could you rephrase? " +
        "For example: 'Add a blog post about…', 'Change the footer text to…', " +
        "or 'Update the hero heading to…'"
      );

    case 'status_check':
      return 'Checking the current deployment status...';

    default: {
      const _exhaustive: never = intent.type;
      return `Processing request: ${String(_exhaustive)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Main orchestration function
// ---------------------------------------------------------------------------

/**
 * **Main entry point for the A3lix parsing pipeline.**
 *
 * Orchestrates both AI steps and returns a fully resolved {@link ParseResult}:
 *
 * 1. Calls {@link classifyIntent} → obtains a {@link ParsedIntent}.
 * 2. If `type === 'unknown'` → returns early with empty changes and a
 *    friendly clarification prompt.
 * 3. If `type === 'status_check'` → returns with empty changes and
 *    `summary: "Checking the current deployment status..."`.
 * 4. If `!requiresFileChanges` → returns with empty changes.
 * 5. If `confidence === 'low'` → proceeds to code generation but adds
 *    hardcoded clarification questions to the result.
 * 6. Calls {@link generateFileChanges} → obtains `FileChange[]`.
 * 7. Builds a human-readable `summary` and returns the full {@link ParseResult}.
 *
 * @param params.message    - The raw message text from the Telegram user.
 * @param params.framework  - The target site framework (`'astro'` or `'nextjs'`).
 * @param params.aiConfig   - Provider config (provider, model, apiKey).
 * @param params.aiBinding  - Cloudflare `Ai` binding.
 * @returns A complete {@link ParseResult} ready to hand back to the caller.
 */
export async function parse(params: {
  message: string;
  framework: 'astro' | 'nextjs';
  aiConfig: AiConfig;
  aiBinding: Ai;
}): Promise<ParseResult> {
  const { message, framework, aiConfig, aiBinding } = params;

  // ── Step 1: Classify ──────────────────────────────────────────────────────
  const intent = await classifyIntent(message, aiConfig, aiBinding);

  // ── Early exits ───────────────────────────────────────────────────────────

  if (intent.type === 'unknown') {
    return {
      intent,
      changes: [],
      summary: buildSummary(intent, []),
    };
  }

  if (intent.type === 'status_check') {
    return {
      intent,
      changes: [],
      summary: buildSummary(intent, []),
    };
  }

  if (!intent.requiresFileChanges) {
    return {
      intent,
      changes: [],
      summary: buildSummary(intent, []),
    };
  }

  // ── Low-confidence: collect clarification questions (but still proceed) ───
  const clarifications: string[] | undefined =
    intent.confidence === 'low'
      ? (CLARIFICATION_QUESTIONS[intent.type] ?? undefined)
      : undefined;

  // ── Step 2: Generate file changes ─────────────────────────────────────────
  const changes = await generateFileChanges(
    message,
    intent,
    framework,
    aiConfig,
    aiBinding,
  );

  // ── Build result ──────────────────────────────────────────────────────────
  const summary = buildSummary(intent, changes);

  const result: ParseResult = {
    intent,
    changes,
    summary,
  };

  if (clarifications !== undefined && clarifications.length > 0) {
    result.clarifications = clarifications;
  }

  return result;
}
