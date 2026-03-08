/// <reference types="@cloudflare/workers-types" />

/**
 * @module roles
 *
 * Multi-user role system for A3lix, backed by Cloudflare KV.
 *
 * Role hierarchy (highest → lowest):
 *   owner  — Full control: request changes, approve previews, manage users.
 *            Exactly one owner, bootstrapped via `npx a3lix init`.
 *   editor — Can request changes but CANNOT approve their own or others' changes.
 *            Onboarded via an OTP whitelist flow approved by the owner.
 *   viewer — Read-only: can ask for status/info only.
 *
 * KV storage schema:
 *   role:${userId}            → 'owner' | 'editor' | 'viewer'   (no TTL)
 *   user:${userId}            → JSON(UserRecord)                  (no TTL)
 *   otp:pending:${userId}     → JSON(OtpRequest)                  (TTL 600s)
 *   otp:validated:${userId}   → '1'                               (TTL 300s)
 *   access:request:${userId}  → JSON(AccessRequest)               (TTL 86400s)
 */

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** The three user roles supported by A3lix. */
export type Role = 'owner' | 'editor' | 'viewer';

/**
 * A persisted user record stored in KV under `user:${userId}`.
 * Written when a role is assigned; never has a TTL.
 */
export interface UserRecord {
  /** Telegram chat ID (string form). */
  userId: string;
  /** The role granted to this user. */
  role: Role;
  /** Telegram username or first name, if available. */
  displayName?: string;
  /** ISO 8601 timestamp of when the record was created. */
  addedAt: string;
  /** userId of who approved them, or `'system'` for the owner bootstrap. */
  addedBy: string;
}

/**
 * An OTP pending validation, stored under `otp:pending:${userId}` with a
 * 600-second TTL.
 */
export interface OtpRequest {
  /** Telegram chat ID of the user this OTP was issued for. */
  userId: string;
  /** 6-digit numeric string (zero-padded). */
  otp: string;
  /** ISO 8601 timestamp of when the OTP was generated. */
  createdAt: string;
  /** ISO 8601 timestamp 10 minutes after `createdAt`. */
  expiresAt: string;
}

/**
 * An access request from an unknown user awaiting owner approval.
 * Stored under `access:request:${userId}` with a 86400-second TTL so the
 * owner receives one notification without queue pile-up.
 */
export interface AccessRequest {
  /** Telegram chat ID of the requesting user. */
  userId: string;
  /** Telegram username or first name, if available. */
  displayName?: string;
  /** ISO 8601 timestamp of when the request was created. */
  requestedAt: string;
  /** The original message the user sent, truncated to 200 characters. */
  messageText: string;
}

/**
 * The result of a role or access check.
 */
export interface RoleCheckResult {
  /** Whether the requested action is permitted. */
  allowed: boolean;
  /** The role of the checked user, if found. */
  role?: Role;
  /**
   * Machine-readable reason for denial.
   * Possible values: `'unknown_user'`, `'insufficient_role'`,
   * `'self_approval_not_allowed'`, `'only_owner_can_approve'`.
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Role priority map used for hierarchy comparisons.
 * Higher number = higher privilege.
 * @internal
 */
const ROLE_PRIORITY: Record<Role, number> = {
  owner: 3,
  editor: 2,
  viewer: 1,
};

/**
 * Constant-time string comparison to prevent timing attacks when comparing
 * OTP values. Returns `true` only when both strings are identical.
 *
 * Note: `crypto.timingSafeEqual` requires `ArrayBuffer`/`Buffer`, so we
 * implement this manually using a bitwise accumulator.
 *
 * @param a - First string to compare.
 * @param b - Second string to compare.
 * @returns `true` if both strings are equal; `false` otherwise.
 * @internal
 */
function otpTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Reads a user's role from KV.
 *
 * @param userId - Telegram chat ID of the user.
 * @param kv     - The `KVNamespace` binding to use.
 * @returns The user's {@link Role}, or `null` if the user is not registered.
 */
export async function getUserRole(
  userId: string,
  kv: KVNamespace,
): Promise<Role | null> {
  const value = await kv.get(`role:${userId}`);
  if (value === 'owner' || value === 'editor' || value === 'viewer') {
    return value;
  }
  return null;
}

/**
 * Writes a user's role to KV and upserts the corresponding {@link UserRecord}.
 * Both keys are permanent (no TTL).
 *
 * @param userId      - Telegram chat ID of the user.
 * @param role        - The {@link Role} to assign.
 * @param displayName - Optional Telegram username or first name.
 * @param approvedBy  - userId of the approver, or `'system'` for bootstrapping.
 * @param kv          - The `KVNamespace` binding to use.
 */
export async function setUserRole(
  userId: string,
  role: Role,
  displayName: string | undefined,
  approvedBy: string,
  kv: KVNamespace,
): Promise<void> {
  const record: UserRecord = {
    userId,
    role,
    ...(displayName !== undefined ? { displayName } : {}),
    addedAt: new Date().toISOString(),
    addedBy: approvedBy,
  };

  await Promise.all([
    kv.put(`role:${userId}`, role),
    kv.put(`user:${userId}`, JSON.stringify(record)),
  ]);
}

/**
 * Checks whether a user has at least the required {@link Role}.
 *
 * Role hierarchy: `owner` ≥ `editor` ≥ `viewer`.
 *
 * @param userId       - Telegram chat ID of the user.
 * @param requiredRole - Minimum role required for the action.
 * @param kv           - The `KVNamespace` binding to use.
 * @returns A {@link RoleCheckResult} indicating whether the user is allowed.
 */
export async function checkAccess(
  userId: string,
  requiredRole: Role,
  kv: KVNamespace,
): Promise<RoleCheckResult> {
  const role = await getUserRole(userId, kv);

  if (role === null) {
    return { allowed: false, reason: 'unknown_user' };
  }

  const allowed = ROLE_PRIORITY[role] >= ROLE_PRIORITY[requiredRole];
  return allowed
    ? { allowed: true, role }
    : { allowed: false, role, reason: 'insufficient_role' };
}

/**
 * Determines whether `userId` is permitted to approve a change that was
 * requested by `requestedByUserId`.
 *
 * Rules:
 * - Only the **owner** may approve changes.
 * - Self-approval is never allowed (even for the owner approving their own
 *   request, though in practice the owner would not need approval).
 *
 * @param userId              - Telegram chat ID of the would-be approver.
 * @param requestedByUserId   - Telegram chat ID of the user who requested the change.
 * @param kv                  - The `KVNamespace` binding to use.
 * @returns A {@link RoleCheckResult} indicating whether approval is allowed.
 */
export async function canApproveChange(
  userId: string,
  requestedByUserId: string,
  kv: KVNamespace,
): Promise<RoleCheckResult> {
  if (userId === requestedByUserId) {
    return { allowed: false, reason: 'self_approval_not_allowed' };
  }

  const role = await getUserRole(userId, kv);

  if (role === null) {
    return { allowed: false, reason: 'unknown_user' };
  }

  if (role !== 'owner') {
    return { allowed: false, role, reason: 'only_owner_can_approve' };
  }

  return { allowed: true, role };
}

/**
 * Creates an {@link AccessRequest} for an unknown user and stores it in KV
 * under `access:request:${userId}` with a 24-hour TTL.
 *
 * Idempotent: if a request already exists for this user, the existing record
 * is returned unchanged.
 *
 * @param userId      - Telegram chat ID of the requesting user.
 * @param displayName - Optional Telegram username or first name.
 * @param messageText - The original message text (truncated to 200 chars).
 * @param kv          - The `KVNamespace` binding to use.
 * @returns The {@link AccessRequest} that is now stored in KV.
 */
export async function initiateAccessRequest(
  userId: string,
  displayName: string | undefined,
  messageText: string,
  kv: KVNamespace,
): Promise<AccessRequest> {
  const key = `access:request:${userId}`;

  // Idempotency: return existing request if present
  const existing = await kv.get(key);
  if (existing !== null) {
    try {
      return JSON.parse(existing) as AccessRequest;
    } catch {
      // Fall through to create a fresh record if the stored value is corrupt
    }
  }

  const request: AccessRequest = {
    userId,
    ...(displayName !== undefined ? { displayName } : {}),
    requestedAt: new Date().toISOString(),
    messageText: messageText.slice(0, 200),
  };

  await kv.put(key, JSON.stringify(request), { expirationTtl: 86400 });
  return request;
}

/**
 * Generates a cryptographically random 6-digit OTP and stores it in KV under
 * `otp:pending:${userId}` with a 10-minute TTL.
 *
 * Uses `crypto.getRandomValues()`, which is available globally in the
 * Cloudflare Workers runtime — no import required.
 *
 * @param userId - Telegram chat ID for which the OTP is being generated.
 * @param kv     - The `KVNamespace` binding to use.
 * @returns The {@link OtpRequest} that was stored in KV.
 */
export async function generateOtp(
  userId: string,
  kv: KVNamespace,
): Promise<OtpRequest> {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  const raw = buf[0] ?? 0;
  const otp = String(raw % 1_000_000).padStart(6, '0');

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 600 * 1000);

  const request: OtpRequest = {
    userId,
    otp,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await kv.put(`otp:pending:${userId}`, JSON.stringify(request), {
    expirationTtl: 600,
  });

  return request;
}

/**
 * Validates a submitted OTP against the pending OTP stored in KV.
 *
 * Uses constant-time comparison ({@link otpTimingSafeEqual}) to prevent
 * timing-based enumeration attacks.
 *
 * On success:
 *   - Deletes `otp:pending:${userId}`
 *   - Writes `otp:validated:${userId}` with a 5-minute TTL
 *
 * On failure: does **not** delete the pending OTP — it expires naturally after
 * its original 10-minute window.
 *
 * @param userId       - Telegram chat ID of the user submitting the OTP.
 * @param submittedOtp - The OTP string provided by the user.
 * @param kv           - The `KVNamespace` binding to use.
 * @returns `true` when the OTP matches; `false` otherwise (including expiry).
 */
export async function validateOtp(
  userId: string,
  submittedOtp: string,
  kv: KVNamespace,
): Promise<boolean> {
  const raw = await kv.get(`otp:pending:${userId}`);
  if (raw === null) return false;

  let request: OtpRequest;
  try {
    request = JSON.parse(raw) as OtpRequest;
  } catch {
    return false;
  }

  if (!otpTimingSafeEqual(submittedOtp, request.otp)) {
    return false;
  }

  // OTP is valid — consume pending key and mark as validated
  await Promise.all([
    kv.delete(`otp:pending:${userId}`),
    kv.put(`otp:validated:${userId}`, '1', { expirationTtl: 300 }),
  ]);

  return true;
}

/**
 * Completes the OTP onboarding flow for a user.
 *
 * Checks that `otp:validated:${userId}` exists (written by {@link validateOtp}
 * with a 5-minute TTL). If present, grants the `editor` role and cleans up
 * all pending keys.
 *
 * @param userId      - Telegram chat ID of the user being onboarded.
 * @param displayName - Optional Telegram username or first name.
 * @param approvedBy  - userId of the owner who approved the onboarding.
 * @param kv          - The `KVNamespace` binding to use.
 * @returns `true` if onboarding succeeded; `false` if the validation window
 *          had expired or the OTP was never validated.
 */
export async function completeOnboarding(
  userId: string,
  displayName: string | undefined,
  approvedBy: string,
  kv: KVNamespace,
): Promise<boolean> {
  const validated = await kv.get(`otp:validated:${userId}`);
  if (validated === null) return false;

  await setUserRole(userId, 'editor', displayName, approvedBy, kv);

  await Promise.all([
    kv.delete(`otp:validated:${userId}`),
    kv.delete(`access:request:${userId}`),
  ]);

  return true;
}

/**
 * Lists all known users by scanning KV keys with the `user:` prefix.
 *
 * Malformed records are silently skipped to keep the function resilient.
 * Results are sorted by {@link UserRecord.addedAt} in ascending order
 * (oldest first).
 *
 * @param kv - The `KVNamespace` binding to use.
 * @returns An array of {@link UserRecord} objects sorted by `addedAt`.
 */
export async function listUsers(kv: KVNamespace): Promise<UserRecord[]> {
  const records: UserRecord[] = [];
  let cursor: string | undefined;

  do {
    const result: KVNamespaceListResult<unknown, string> = await kv.list({
      prefix: 'user:',
      ...(cursor ? { cursor } : {}),
    });

    const fetches = result.keys.map(async ({ name }) => {
      const raw = await kv.get(name);
      if (raw === null) return;
      try {
        const record = JSON.parse(raw) as UserRecord;
        records.push(record);
      } catch {
        // Skip malformed records
      }
    });

    await Promise.all(fetches);

    cursor = result.list_complete ? undefined : (result as { cursor?: string }).cursor;
  } while (cursor !== undefined);

  records.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  return records;
}

/**
 * Bootstraps the owner's role in KV during `npx a3lix init`.
 *
 * Idempotent: if an owner record already exists for `ownerUserId`, this
 * function returns without making any changes.
 *
 * @param ownerUserId - Telegram chat ID designated as the owner.
 * @param displayName - Optional Telegram username or first name.
 * @param kv          - The `KVNamespace` binding to use.
 */
export async function bootstrapOwner(
  ownerUserId: string,
  displayName: string | undefined,
  kv: KVNamespace,
): Promise<void> {
  const existing = await getUserRole(ownerUserId, kv);
  if (existing !== null) return;

  await setUserRole(ownerUserId, 'owner', displayName, 'system', kv);
}
