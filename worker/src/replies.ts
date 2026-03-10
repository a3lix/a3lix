/// <reference types="@cloudflare/workers-types" />

/**
 * replies.ts — All user-facing message templates for the A3lix Telegram bot.
 *
 * Every string the bot sends to users lives here. This module is the single
 * source of truth for tone, formatting, and i18n-readiness. All templates use
 * Telegram MarkdownV2 formatting and must pass user-supplied values through
 * `esc()` before interpolation.
 */

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Escapes all Telegram MarkdownV2 special characters in a string so that
 * user-provided values can be safely interpolated into message templates.
 *
 * Characters escaped: _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 *
 * @param text - Raw text that may contain MarkdownV2 special characters.
 * @returns The escaped string, safe for use inside a MarkdownV2 message.
 */
export function esc(text: string): string {
  // eslint-disable-next-line no-useless-escape
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Onboarding / Access replies
// ---------------------------------------------------------------------------

/**
 * Sent to an unknown (unapproved) user who messages the bot.
 *
 * @param displayName - The user's Telegram display name, if available.
 * @returns MarkdownV2-safe message string.
 */
export function replyUnknownUser(displayName?: string): string {
  const name = displayName ? esc(displayName) : "there";
  return (
    `👋 Hey ${name}\\! I don't recognise you yet\\.\n\n` +
    `I've pinged the owner for approval\\. Hang tight — once they approve you, ` +
    `you'll receive a one\\-time code to enter here to activate your access\\.`
  );
}

/**
 * Sent to the OWNER when a new user requests access.
 *
 * @param displayName - The requesting user's Telegram display name.
 * @param userId      - The requesting user's Telegram user ID.
 * @param messagePreview - A short preview of the message the user sent.
 * @returns MarkdownV2-safe message string.
 */
export function replyOwnerApprovalNeeded(
  displayName: string | undefined,
  userId: string,
  messagePreview: string,
): string {
  const name = displayName ? `@${esc(displayName)}` : "\\(unknown\\)";
  return (
    `🔔 *New access request\\!*\n\n` +
    `👤 User: ${name} \\(ID: \`${esc(userId)}\`\\)\n` +
    `💬 Their message: _"${esc(messagePreview)}"_\n\n` +
    `Reply *YES* to approve or *IGNORE* to dismiss\\.`
  );
}

/**
 * Sent to a newly approved user — contains their one-time password.
 *
 * @param otp - The one-time password string to display.
 * @returns MarkdownV2-safe message string.
 */
export function replyOtpIssued(otp: string): string {
  return (
    `✅ You're approved\\!\n\n` +
    `Enter this code to activate your access:\n\n` +
    `\`${esc(otp)}\`\n\n` +
    `⏱ This code expires in *10 minutes*\\.`
  );
}

/**
 * Sent when a user enters a wrong or expired OTP.
 *
 * @returns MarkdownV2-safe message string.
 */
export function replyOtpInvalid(): string {
  return (
    `❌ That code didn't work\\. It may have expired\\.\n\n` +
    `Ask the owner to approve you again and you'll receive a fresh code\\.`
  );
}

/**
 * Sent after a user successfully validates their OTP — welcoming them as an editor.
 *
 * @param displayName - The user's Telegram display name, if available.
 * @returns MarkdownV2-safe message string.
 */
export function replyWelcomeEditor(displayName?: string): string {
  const name = displayName ? esc(displayName) : "friend";
  return (
    `🎉 You're in, ${name}\\!\n\n` +
    `You can now send me site update requests\\. Here are some examples to get started:\n\n` +
    `• _"Add a blog post about our new product launch"_\n` +
    `• _"Change the hero heading to Welcome to Acme Co"_\n` +
    `• _"Update the footer text to © 2025 Acme Co"_\n\n` +
    `Just describe what you want in plain English and I'll handle the rest\\ ✨`
  );
}

// ---------------------------------------------------------------------------
// Change request flow replies
// ---------------------------------------------------------------------------

/**
 * Shown immediately while the AI is processing a request (before the result is known).
 *
 * @returns MarkdownV2-safe message string.
 */
export function replyParsing(): string {
  return `🔍 Got it\\! Analysing your request\\.\\.\\.`;
}

/**
 * Shown when the AI could not classify the user's intent.
 *
 * @returns MarkdownV2-safe message string.
 */
export function replyUnknownIntent(): string {
  return (
    `🤔 I didn't quite understand that\\.\n\n` +
    `Try something like:\n` +
    `• _"Add a blog post about\\.\\.\\."_\n` +
    `• _"Change the hero heading to\\.\\.\\."_\n` +
    `• _"Update the footer text to\\.\\.\\."_\n\n` +
    `The more detail you give me, the better\\!`
  );
}

/**
 * Shown when the AI confidence is low and it needs clarification from the user.
 *
 * @param questions - Array of clarifying questions to present to the user.
 * @returns MarkdownV2-safe message string.
 */
export function replyNeedsClarification(questions: string[]): string {
  const numbered = questions
    .map((q, i) => `${i + 1}\\. ${esc(q)}`)
    .join("\n");
  return (
    `🧐 A few quick questions before I get started:\n\n` +
    `${numbered}\n\n` +
    `Just reply with your answers and I'll take it from there\\.`
  );
}

/**
 * The primary reply after a preview branch has been deployed.
 * Includes the change summary, a clickable preview URL, estimated build time,
 * and clear approval instructions.
 *
 * @param params.summary          - Human-readable description of what was changed.
 * @param params.previewUrl       - Full URL to the preview deployment.
 * @param params.estimatedSeconds - Approximate build duration in seconds.
 * @param params.branchName       - Name of the preview Git branch.
 * @returns MarkdownV2-safe message string.
 */
export function replyPreviewReady(params: {
  summary: string;
  previewUrl: string;
  estimatedSeconds: number;
  branchName: string;
}): string {
  const { summary, previewUrl, estimatedSeconds, branchName } = params;
  return (
    `🚀 *Preview ready\\!*\n\n` +
    `📝 ${esc(summary)}\n\n` +
    `🔗 [Open preview](${previewUrl})\n\n` +
    `🌿 Branch: \`${esc(branchName)}\`\n\n` +
    `⏱ Build takes ~*${esc(String(estimatedSeconds))} seconds* to complete\\.\n\n` +
    `✅ Reply *YES* to publish to your live site, or anything else to cancel\\.`
  );
}

/**
 * Shown to editors when they try to approve a preview — only the owner can approve.
 *
 * @param previewUrl - The URL of the live preview.
 * @returns MarkdownV2-safe message string.
 */
export function replyApprovalPending(previewUrl: string): string {
  return (
    `⏳ Your preview is live at [this link](${previewUrl})\\.\n\n` +
    `The owner needs to approve it before it goes live — I've notified them\\!`
  );
}

/**
 * Shown after a successful merge to the main branch.
 *
 * @param params.summary   - Human-readable description of what was published.
 * @param params.commitSha - The full commit SHA (will be truncated to 7 chars).
 * @returns MarkdownV2-safe message string.
 */
export function replyMerged(params: {
  summary: string;
  commitSha: string;
}): string {
  const { summary, commitSha } = params;
  const shortSha = esc(commitSha.slice(0, 7));
  return (
    `✅ *Published\\!*\n\n` +
    `${esc(summary)} is now live\\.\n\n` +
    `Commit: \`${shortSha}\`\n\n` +
    `🎉 Your changes are deploying to the live site now\\.`
  );
}

/**
 * Shown when the owner does NOT reply YES — the preview is cancelled and the
 * branch is cleaned up.
 *
 * @returns MarkdownV2-safe message string.
 */
export function replyCancelled(): string {
  return (
    `🗑️ Got it — preview cancelled\\.\n\n` +
    `The branch has been cleaned up\\. Send me a new request whenever you're ready\\!`
  );
}

/**
 * Shown when the owner replies YES but there is no pending preview to approve.
 *
 * @returns MarkdownV2-safe message string.
 */
export function replyNoPendingApproval(): string {
  return (
    `🤷 No pending preview found\\.\n\n` +
    `It may have expired \\(previews last 24h\\)\\. ` +
    `Send a new request to start fresh\\.`
  );
}

// ---------------------------------------------------------------------------
// Access control replies
// ---------------------------------------------------------------------------

/**
 * Shown when a viewer tries to submit a change request (viewers are read-only).
 *
 * @returns MarkdownV2-safe message string.
 */
export function replyViewerCannotEdit(): string {
  return (
    `👁️ You're set up as a *viewer* — you can ask for status updates but can't ` +
    `request changes\\.\n\n` +
    `Ask the owner to upgrade your role if you need edit access\\.`
  );
}

/**
 * Shown when a user has hit their daily change request limit.
 *
 * @param limit - The maximum number of daily changes allowed.
 * @returns MarkdownV2-safe message string.
 */
export function replyRateLimited(limit: number): string {
  return (
    `⏸️ You've hit the daily limit of *${esc(String(limit))} changes*\\.\n\n` +
    `Come back tomorrow and you'll be good to go\\!`
  );
}

/**
 * Shown when a guardrail check blocks a request (e.g. unsafe path, destructive keyword).
 *
 * @param reason - Short explanation of why the request was blocked.
 * @returns MarkdownV2-safe message string.
 */
export function replyGuardrailBlocked(reason: string): string {
  return (
    `🛡️ I can't do that — it looks like a potentially unsafe change \\(${esc(reason)}\\)\\.\n\n` +
    `If you think this is a mistake, contact your developer\\.`
  );
}

/**
 * Shown when a specific file path is not in the allowed list.
 *
 * @param path - The file path that was blocked.
 * @returns MarkdownV2-safe message string.
 */
export function replyPathBlocked(path: string): string {
  return (
    `🔒 I can't modify \`${esc(path)}\` — it's outside the allowed areas\\.\n\n` +
    `Allowed paths: \`src/content\`, \`src/components\`, \`src/pages\`, \`public\`\\.`
  );
}

// ---------------------------------------------------------------------------
// Error / system replies
// ---------------------------------------------------------------------------

/**
 * Generic internal error reply — never exposes internal details to the user.
 *
 * @returns MarkdownV2-safe message string.
 */
export function replyInternalError(): string {
  return (
    `😬 Something went wrong on my end\\.\n\n` +
    `Please try again in a moment\\. If this keeps happening, let your developer know\\.`
  );
}

/**
 * Shown when a GitHub API call fails.
 *
 * @param endpoint - The GitHub API endpoint that failed (will be escaped).
 * @returns MarkdownV2-safe message string.
 */
export function replyGitHubError(endpoint: string): string {
  return (
    `⚠️ Couldn't reach GitHub \\(\`${esc(endpoint)}\`\\)\\.\n\n` +
    `Check that your GitHub token is valid and the repo exists\\.`
  );
}

/**
 * Response to a status query from a viewer or editor.
 * Shows pending approvals count, last deploy timestamp, and a link to the
 * Cloudflare Pages project.
 *
 * @param params.pendingCount       - Number of change requests awaiting approval.
 * @param params.lastDeployedAt     - ISO timestamp of the last deployment, if available.
 * @param params.pagesProjectName   - Name of the Cloudflare Pages project.
 * @returns MarkdownV2-safe message string.
 */
export function replyStatusCheck(params: {
  pendingCount: number;
  lastDeployedAt?: string;
  pagesProjectName: string;
}): string {
  const { pendingCount, lastDeployedAt, pagesProjectName } = params;
  const lastDeploy = lastDeployedAt ? esc(lastDeployedAt) : "never";
  return (
    `📊 *Status*\n\n` +
    `• ${esc(String(pendingCount))} change\\(s\\) waiting for approval\n` +
    `• Last deployed: ${lastDeploy}\n` +
    `• Pages project: \`${esc(pagesProjectName)}\``
  );
}

// ---------------------------------------------------------------------------
// Telegram API helper
// ---------------------------------------------------------------------------

/**
 * Sends a MarkdownV2-formatted message to a Telegram chat via the Bot API.
 *
 * @param params.chatId   - The target chat ID (numeric or string).
 * @param params.text     - The MarkdownV2-formatted message text to send.
 * @param params.botToken - The Telegram bot token.
 * @throws {Error} If the Telegram API returns a non-OK HTTP status.
 * @returns A promise that resolves when the message has been sent successfully.
 */
export async function sendTelegramMessage(params: {
  chatId: string | number;
  text: string;
  botToken: string;
}): Promise<void> {
  const { chatId, text, botToken } = params;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(
      `Telegram sendMessage failed [HTTP ${response.status}] for chat ${chatId}: ${body}`,
    );
  }
}
