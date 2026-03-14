/// <reference types="@cloudflare/workers-types" />

/**
 * @module replies
 *
 * All Telegram message templates for A3lix.
 *
 * Uses Telegram HTML parse mode — much more lenient than MarkdownV2.
 * Only <, > and & need escaping in text content.
 * Links use: <a href="URL">text</a>
 */

// ---------------------------------------------------------------------------
// HTML escape helper
// ---------------------------------------------------------------------------

/**
 * Escapes the three HTML special characters that Telegram HTML mode requires.
 * Safe to call on any user-supplied string before interpolating into a message.
 */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Reply functions
// ---------------------------------------------------------------------------

export function replyUnknownUser(displayName?: string): string {
  const name = displayName ? esc(displayName) : 'there';
  return (
    `👋 Hi ${name}!\n\n` +
    `I don't recognise you yet. I've let the site owner know you'd like access.\n\n` +
    `They'll send you a 6-digit code — just reply with it here to get started.`
  );
}

export function replyOwnerApprovalNeeded(
  displayName: string | undefined,
  userId: string,
  messagePreview: string,
): string {
  const name = displayName ? `@${esc(displayName)}` : '(unknown)';
  return (
    `🔔 <b>Access Request</b>\n\n` +
    `👤 User: ${name} (ID: <code>${esc(userId)}</code>)\n` +
    `💬 Their message: <i>"${esc(messagePreview)}"</i>\n\n` +
    `Reply <b>YES</b> to grant them access and send an OTP.`
  );
}

export function replyOtpIssued(otp: string): string {
  return (
    `✅ <b>Your access code:</b>\n\n` +
    `<code>${esc(otp)}</code>\n\n` +
    `Reply with this code to confirm your access.\n` +
    `It expires in 10 minutes.`
  );
}

export function replyOtpInvalid(): string {
  return (
    `❌ That code is invalid or expired.\n\n` +
    `Please ask the site owner to approve your access again.`
  );
}

export function replyWelcomeEditor(displayName?: string): string {
  const name = displayName ? esc(displayName) : 'friend';
  return (
    `🎉 Welcome, ${name}!\n\n` +
    `You now have editor access. Just describe what you'd like to change and I'll handle it.\n\n` +
    `For example:\n` +
    `• "Change the hero headline to..."\n` +
    `• "Add a blog post about..."\n` +
    `• "Update the footer text to..."`
  );
}

export function replyParsing(): string {
  return `🔍 Got it! Analysing your request...`;
}

export function replyDeployChoice(summary: string): string {
  return (
    `✅ <b>Request analysed.</b>\n\n` +
    `${esc(summary)}\n\n` +
    `Reply <b>LIVE</b> to push changes live right away, or <b>PREVIEW</b> to create a preview first.`
  );
}

export function replyPreviewBuilding(): string {
  return `🏗️ Change prepared. Triggering Cloudflare preview build now...`;
}

export function replyPreviewQueued(params: {
  branchName: string;
  estimatedSeconds: number;
}): string {
  const { branchName, estimatedSeconds } = params;
  return (
    `⏳ <b>Preview is building</b>\n\n` +
    `Expected build time: ~${estimatedSeconds}s\n\n` +
    `🌿 Branch: <code>${esc(branchName)}</code>\n\n` +
    `I'll notify you when it's ready for approval.`
  );
}


export function replyPreviewFailed(params: {
  summary: string;
  branchName: string;
  reason?: string;
}): string {
  const { summary, branchName, reason } = params;
  const detail = reason ? `\n\nReason: ${esc(reason)}` : '';
  return (
    `❌ <b>Preview build failed</b>\n\n` +
    `📝 ${esc(summary)}\n` +
    `🌿 Branch: <code>${esc(branchName)}</code>` +
    detail
  );
}

export function replyUnknownIntent(): string {
  return (
    `🤔 I didn't quite understand that.\n\n` +
    `Try something like:\n` +
    `• "Add a blog post about..."\n` +
    `• "Change the hero heading to..."\n` +
    `• "Update the footer text to..."\n\n` +
    `The more detail you give me, the better!`
  );
}

export function replyNeedsClarification(clarifications: string[]): string {
  const qs = clarifications.map((q, i) => `${i + 1}. ${esc(q)}`).join('\n');
  return (
    `🤔 I need a bit more info:\n\n` +
    qs
  );
}

export function replyDiffPreview(params: {
  summary: string;
  changes: Array<{ path: string; before?: string; after: string }>;
  pendingId: string;
}): string {
  const { summary, changes, pendingId } = params;

  // Build a readable diff for each changed file.
  const diffLines: string[] = [];
  for (const change of changes.slice(0, 3)) { // max 3 files shown
    diffLines.push(`\n📄 <b>${esc(change.path)}</b>`);
    if (change.before) {
      // Find changed lines by comparing before/after
      const beforeLines = change.before.split('\n');
      const afterLines = change.after.split('\n');
      let shownCount = 0;
      for (let i = 0; i < Math.max(beforeLines.length, afterLines.length) && shownCount < 8; i++) {
        const b = beforeLines[i] ?? '';
        const a = afterLines[i] ?? '';
        if (b !== a) {
          if (b) diffLines.push(`  ➖ <i>${esc(b.trim().slice(0, 100))}</i>`);
          if (a) diffLines.push(`  ➕ <i>${esc(a.trim().slice(0, 100))}</i>`);
          shownCount++;
        }
      }
      if (shownCount === 0) {
        // Files differ but line numbers don't match — show first/last changed
        diffLines.push(`  (content updated)`);
      }
    } else {
      diffLines.push(`  (new file created)`);
    }
  }

  return (
    `✏️ <b>Here's what I'll change:</b>\n\n` +
    `${esc(summary)}\n` +
    diffLines.join('\n') +
    `\n\n✅ Reply <b>YES</b> to apply\n❌ Reply <b>NO</b> to cancel`
  );
}

export function replyApprovalPending(): string {
  return (
    `⏳ A change is waiting for your approval.\n\n` +
    `Reply <b>YES</b> to approve and go live, or <b>NO</b> to reject.`
  );
}


export function replyMerged(params: { summary: string; commitSha: string }): string {
  const { summary, commitSha } = params;
  return (
    `✅ <b>Change approved and merged!</b>\n\n` +
    `${esc(summary)}\n\n` +
    `Commit: <code>${esc(commitSha.slice(0, 7))}</code>\n\n` +
    `Your site will update in about a minute.`
  );
}

export function replyCancelled(): string {
  return (
    `❌ Change rejected.\n\n` +
    `The preview branch has been deleted. No changes were made to your site.`
  );
}

export function replyNoPendingApproval(): string {
  return `ℹ️ There are no pending approvals right now.`;
}

export function replyViewerCannotEdit(): string {
  return (
    `👀 You have view-only access.\n\n` +
    `You can ask about the current deployment status, but content changes\n` +
    `need to be requested by an editor.`
  );
}

export function replyRateLimited(limit: number): string {
  return (
    `⏱ You've reached the daily limit of ${limit} change requests.\n\n` +
    `Please try again tomorrow.`
  );
}

export function replyGuardrailBlocked(reason: string): string {
  return (
    `🛡️ I can't do that — it looks like a potentially unsafe change (${esc(reason)}).\n\n` +
    `If you think this is a mistake, contact your developer.`
  );
}

export function replyPathBlocked(path: string): string {
  return (
    `🛡️ That file path is outside the permitted write zone: <code>${esc(path)}</code>\n\n` +
    `Only content in allowed directories can be modified.`
  );
}

export function replyInternalError(): string {
  return (
    `😬 Something went wrong on my end.\n\n` +
    `Please try again in a moment. If this keeps happening, let your developer know.`
  );
}

export function replyGitHubError(endpoint: string): string {
  return (
    `⚠️ Couldn't reach GitHub (<code>${esc(endpoint)}</code>).\n\n` +
    `Check that your GitHub token is valid and the repo exists.`
  );
}

export function replyStatusCheck(params: {
  pendingCount: number;
  lastDeployedAt?: string;
  pagesProjectName: string;
}): string {
  const { pendingCount, lastDeployedAt, pagesProjectName } = params;
  const lastDeploy = lastDeployedAt ? esc(lastDeployedAt) : 'never';
  return (
    `📊 <b>Status</b>\n\n` +
    `• ${pendingCount} change(s) waiting for approval\n` +
    `• Last deployed: ${lastDeploy}\n` +
    `• Pages project: <code>${esc(pagesProjectName)}</code>`
  );
}

// ---------------------------------------------------------------------------
// Telegram API helper
// ---------------------------------------------------------------------------

/**
 * Sends an HTML-formatted message to a Telegram chat via the Bot API.
 */
export async function sendTelegramMessage(params: {
  chatId: string | number;
  text: string;
  botToken: string;
}): Promise<void> {
  const { chatId, text, botToken } = params;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(no body)');
    throw new Error(
      `Telegram sendMessage failed [HTTP ${response.status}] for chat ${chatId}: ${body}`,
    );
  }
}
