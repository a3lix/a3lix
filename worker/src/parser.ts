/// <reference types="@cloudflare/workers-types" />

/**
 * @module parser
 *
 * Single-pass AI parsing for A3lix.
 *
 * Combines intent classification AND file-change generation into ONE AI call.
 * This cuts AI latency in half (one round-trip instead of two) and ensures
 * the pipeline completes within Cloudflare Workers' 30-second waitUntil limit.
 *
 * The AI returns a single JSON object with three fields:
 *   - intent   — classified intent (type, confidence, metadata, requiresFileChanges)
 *   - changes  — array of file changes to apply
 *   - summary  — human-readable description of what will be done
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
 * The classified intent from the AI.
 */
export interface ParsedIntent {
  type: IntentType;
  confidence: 'high' | 'medium' | 'low';
  affectedPaths: string[];
  metadata: Record<string, string>;
  requiresFileChanges: boolean;
}

/**
 * A single file change produced by the AI.
 * For updates to existing files, use `find`/`replace` instead of full `content`
 * to avoid JSON encoding issues with large files.
 */
export interface FileChange {
  path: string;
  /** Full file content — used for new files (operation: 'create') */
  content: string;
  operation: 'create' | 'update';
  /** For updates: exact string to find in the existing file */
  find?: string;
  /** For updates: string to replace the found text with */
  replace?: string;
}

/**
 * The full result returned by {@link parse} to the caller.
 */
export interface ParseResult {
  intent: ParsedIntent;
  changes: FileChange[];
  summary: string;
  clarifications?: string[];
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const PROVIDER_URLS: Record<Exclude<AiProvider, 'workers-ai'>, string> = {
  openai:      'https://api.openai.com/v1/chat/completions',
  grok:        'https://api.x.ai/v1/chat/completions',
  groq:        'https://api.groq.com/openai/v1/chat/completions',
  claude:      'https://api.anthropic.com/v1/messages',
  gemini:      'https://generativelanguage.googleapis.com/v1beta/models',
  openrouter:  'https://openrouter.ai/api/v1/chat/completions',
};

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

// ---------------------------------------------------------------------------
// Single-pass system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  framework: 'astro' | 'nextjs',
  fileTree?: string,
  fileContents?: Record<string, string>,
): string {
  const treeSection = fileTree
    ? `\n\nRepository source files (use EXACT paths — match case precisely):\n${fileTree}\n\nIMPORTANT: For files that already exist in the list above, use operation:"update". Use operation:"create" only for genuinely new files.`
    : '';

  const hasFileContents = fileContents && Object.keys(fileContents).length > 0;

  const contentSection = hasFileContents
    ? '\n\nCurrent file contents provided for surgical editing:\n' +
      Object.entries(fileContents!)
        .map(([path, content]) => `\n--- ${path} (${content.split('\n').length} lines) ---\n${content.slice(0, 4000)}${content.length > 4000 ? '\n...(truncated)' : ''}\n--- end ${path} ---`)
        .join('\n')
    : '';

  const changesSchema = hasFileContents
    ? `[
    {
      "path": "exact/path/from/file/tree",
      "operation": "update",
      "find": "exact string to find in the file (copy verbatim from the file content above)",
      "replace": "new string to replace it with",
      "content": ""
    }
  ]`
    : `[
    {
      "path": "repo-relative/path/to/file",
      "content": "complete file content as a string",
      "operation": "create"|"update"
    }
  ]`;

  const changesInstructions = hasFileContents
    ? `- CRITICAL: Use "find"/"replace" for edits to existing files. The "find" value must exactly match text in the current file (character for character). The "replace" value is what replaces it. Set "content" to empty string "".
- Only make the MINIMAL change — do not rewrite, restructure, or expand the file.`
    : `- For any edit/create intent: populate "content" with the COMPLETE new file content.`;

  return `You are A3lix, an AI agent that helps non-technical clients update their ${framework} website by text message.

Analyse the user's message and respond with ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "intent": {
    "type": one of: new_blog_post|new_page|edit_text|edit_colors|edit_component|edit_footer|edit_hero|multi_file_edit|status_check|unknown,
    "confidence": "high"|"medium"|"low",
    "affectedPaths": [array of file paths that will be changed],
    "metadata": {key-value strings extracted from the message, e.g. title, color, text},
    "requiresFileChanges": true|false
  },
  "changes": ${changesSchema},
  "summary": "Human-readable one-line description of what will be changed"
}

Rules:
- status_check: user asks what is currently deployed → set requiresFileChanges:false, changes:[], summary describes status
- unknown: cannot classify → set requiresFileChanges:false, changes:[], summary asks user to rephrase
${changesInstructions}
- Framework: ${framework}
- NEVER include process.env, eval, require('child_process'), .env references, or secrets
- Return ONLY the JSON object, starting with { and ending with }${treeSection}${contentSection}`;
}

// ---------------------------------------------------------------------------
// Response sanitiser
// ---------------------------------------------------------------------------

/**
 * Strips markdown code fences and extracts the first JSON object from the
 * raw AI response string.
 */
function stripFences(raw: string): string {
  let cleaned = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1] !== undefined) {
    cleaned = fenceMatch[1].trim();
  }

  // Extract the first JSON object {...} — handles leading prose.
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) return objectMatch[0];

  return cleaned;
}

// ---------------------------------------------------------------------------
// Safe fallback
// ---------------------------------------------------------------------------

const FALLBACK_RESULT: ParseResult = {
  intent: {
    type: 'unknown',
    confidence: 'low',
    affectedPaths: [],
    metadata: {},
    requiresFileChanges: false,
  },
  changes: [],
  summary: "I didn't quite understand that. Could you rephrase? For example: 'Change the hero headline to…', 'Add a blog post about…'",
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isParsedIntent(value: unknown): value is ParsedIntent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const validTypes: IntentType[] = [
    'new_blog_post', 'new_page', 'edit_text', 'edit_colors',
    'edit_component', 'edit_footer', 'edit_hero', 'multi_file_edit',
    'status_check', 'unknown',
  ];
  if (!validTypes.includes(v['type'] as IntentType)) return false;
  if (v['confidence'] !== 'high' && v['confidence'] !== 'medium' && v['confidence'] !== 'low') return false;
  if (!Array.isArray(v['affectedPaths'])) return false;
  if (typeof v['metadata'] !== 'object' || v['metadata'] === null) return false;
  if (typeof v['requiresFileChanges'] !== 'boolean') return false;
  return true;
}

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
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
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
      contents: [{ parts: [{ text: user }] }],
      systemInstruction: { parts: [{ text: system }] },
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
// callAi — exported for testing
// ---------------------------------------------------------------------------

export async function callAi(
  prompt: { system: string; user: string },
  aiConfig: AiConfig,
  aiBinding: Ai,
): Promise<string> {
  const { system, user } = prompt;
  const { provider, model, apiKey } = aiConfig;

  switch (provider) {
    case 'workers-ai': {
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
      if (!apiKey) throw new Error(`Provider "${provider}" requires an apiKey in AiConfig`);
      const extraHeaders = provider === 'openrouter'
        ? { 'HTTP-Referer': 'https://a3lix.com', 'X-Title': 'A3lix' }
        : {};
      return callOpenAiCompatible(PROVIDER_URLS[provider], apiKey, model, system, user, extraHeaders);
    }

    case 'claude': {
      if (!apiKey) throw new Error(`Provider "claude" requires an apiKey in AiConfig`);
      return callClaude(apiKey, model, system, user);
    }

    case 'gemini': {
      if (!apiKey) throw new Error(`Provider "gemini" requires an apiKey in AiConfig`);
      return callGemini(apiKey, model, system, user);
    }

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown AI provider: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main parse function — single AI call
// ---------------------------------------------------------------------------

/**
 * Sends a single AI request that returns intent + file changes + summary
 * in one JSON response. Replaces the previous two-step classify→generate flow.
 */
export async function parse(params: {
  message: string;
  framework: 'astro' | 'nextjs';
  aiConfig: AiConfig;
  aiBinding: Ai;
  fileTree?: string;
  fileContents?: Record<string, string>;
}): Promise<ParseResult> {
  const { message, framework, aiConfig, aiBinding, fileTree, fileContents } = params;
  const systemPrompt = buildSystemPrompt(framework, fileTree, fileContents);

  let rawResponse: string;
  try {
    rawResponse = await callAi(
      { system: systemPrompt, user: message },
      aiConfig,
      aiBinding,
    );
  } catch (err) {
    console.error('[a3lix] parse: callAi threw', err);
    return { ...FALLBACK_RESULT };
  }

  if (!rawResponse || rawResponse.trim() === '') {
    console.error('[a3lix] parse: AI returned empty response');
    return { ...FALLBACK_RESULT };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(rawResponse));
  } catch (err) {
    console.error('[a3lix] parse: JSON.parse failed. Raw (first 300):', rawResponse.slice(0, 300));
    return { ...FALLBACK_RESULT };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    console.error('[a3lix] parse: parsed result is not an object');
    return { ...FALLBACK_RESULT };
  }

  const p = parsed as Record<string, unknown>;

  // Validate intent
  const intentRaw = p['intent'];
  if (!isParsedIntent(intentRaw)) {
    console.error('[a3lix] parse: intent failed type guard:', JSON.stringify(intentRaw).slice(0, 200));
    return { ...FALLBACK_RESULT };
  }
  const intent = intentRaw;

  // Early exits
  if (intent.type === 'unknown' || intent.type === 'status_check' || !intent.requiresFileChanges) {
    const summaryRaw = p['summary'];
    const summary = typeof summaryRaw === 'string' ? summaryRaw : FALLBACK_RESULT.summary;
    return { intent, changes: [], summary };
  }

  // Validate changes
  const changesRaw = p['changes'];
  const changes: FileChange[] = Array.isArray(changesRaw)
    ? changesRaw.filter(isFileChange)
    : [];

  if (changes.length === 0) {
    console.error('[a3lix] parse: changes array is empty or all items failed type guard. changesRaw:', JSON.stringify(changesRaw).slice(0, 300));
  }

  // Summary
  const summaryRaw = p['summary'];
  const summary = typeof summaryRaw === 'string' && summaryRaw.trim() !== ''
    ? summaryRaw
    : `I'll update ${changes.length} file(s). Ready to preview?`;

  // Clarifications for low confidence
  const clarifications: string[] | undefined =
    intent.confidence === 'low'
      ? (CLARIFICATION_QUESTIONS[intent.type] ?? undefined)
      : undefined;

  const result: ParseResult = { intent, changes, summary };
  if (clarifications !== undefined && clarifications.length > 0) {
    result.clarifications = clarifications;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Legacy exports kept for backward compatibility
// ---------------------------------------------------------------------------

export async function classifyIntent(
  message: string,
  aiConfig: AiConfig,
  aiBinding: Ai,
): Promise<ParsedIntent> {
  const result = await parse({ message, framework: 'nextjs', aiConfig, aiBinding });
  return result.intent;
}

export async function generateFileChanges(
  message: string,
  intent: ParsedIntent,
  framework: 'astro' | 'nextjs',
  aiConfig: AiConfig,
  aiBinding: Ai,
): Promise<FileChange[]> {
  const result = await parse({ message, framework, aiConfig, aiBinding });
  return result.changes;
}
