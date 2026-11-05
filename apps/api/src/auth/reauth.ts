import type { Pool, PoolClient } from "pg";
import { reauthCodeEmail } from "#src/auth/email/templates";
import type { EmailSender } from "#src/auth/email/sender";
import { generateCode, generateToken, hashToken, type AuthKeys } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import type { SessionOwner } from "#src/auth/session";
import { keysFor, reasonOf, recordFailure, say, type Caller } from "#src/auth/sign-in";
import { BUCKETS, countRecent, record, tryLock } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/** A staff re-authentication code lives as long as the sign-in code (10 minutes, migration 0155). */
export const STAFF_REAUTH_SECONDS = AUTH_LIMITS.challengeValiditySeconds;

export type StaffReauthDeps = Readonly<{ pool: Pool; keys: AuthKeys; email: EmailSender }>;

export type StaffReauthStart =
  | Readonly<{ kind: "code_sent"; challengeToken: string; expiresInSeconds: number }>
  | Readonly<{ kind: "throttled"; retryAfterSeconds: number }>
  | Readonly<{ kind: "email_unavailable" }>;

export type StaffReauthConfirm =
  | Readonly<{ kind: "confirmed"; freshUntil: Date }>
  | Readonly<{ kind: "invalid_code"; attemptsLeft: number }>
  | Readonly<{ kind: "challenge_expired" }>;

/** The owner of a re-authentication: the session's user, their own address, and the session token's hash. */
export type ReauthOwner = SessionOwner & Readonly<{ email: string }>;

const asUser = <T>(pool: Pool, staffUserId: string, work: (client: PoolClient) => Promise<T>) =>
  withConnection(pool, (client) => withRequestContext(client, { staffUserId }, () => work(client)));

const L = AUTH_LIMITS;

/** A code's hash, bound to its own challenge by the token's hash. */
const codeHashOf = (keys: AuthKeys, tokenHash: string, code: string): Buffer =>
  keys.codeHash(tokenHash, code);

type Opened =
  | Readonly<{ kind: "opened"; token: string; code: string }>
  | Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

/**
 * In one transaction as the user: the hourly code cap shared with sign-in (`challengesPerUser`), then the session's
 * challenge (`start_staff_reauth`: at most 3 resends, 60 seconds apart).
 */
async function openReauth(deps: StaffReauthDeps, who: ReauthOwner): Promise<Opened> {
  return asUser(deps.pool, who.staffUserId, async (client) => {
    const userKey = deps.keys.userKey(who.staffUserId);
    // Stryker disable next-line ConditionalExpression,BlockStatement,ObjectLiteral: lock contention between two requests of one user: timing, not a path a test can hold
    if (!(await tryLock(client, userKey))) {
      return { kind: "throttled", retryAfterSeconds: 1 } as const;
    }
    const recent = await countRecent(
      client,
      BUCKETS.challengeUser,
      userKey,
      L.challengesPerUser.windowSeconds,
    );
    if (recent.count >= L.challengesPerUser.max) {
      return { kind: "throttled", retryAfterSeconds: recent.retryAfterSeconds } as const;
    }
    const token = generateToken();
    const code = generateCode();
    const { rows } = await client.query<{
      outcome: "started" | "wait" | "too_many";
      retry_after: number;
    }>(
      "SELECT outcome, retry_after FROM start_staff_reauth(decode($1, 'hex'), decode($2, 'hex'), $3)",
      [who.tokenHash, token.hash, codeHashOf(deps.keys, token.hash, code)],
    );
    const row = rows[0];
    if (row?.outcome !== "started") {
      return { kind: "throttled", retryAfterSeconds: Math.max(1, row?.retry_after ?? 1) } as const;
    }
    await record(client, BUCKETS.challengeUser, userKey);
    return { kind: "opened", token: token.token, code } as const;
  });
}

/** Emails a fresh code to the account's own address, to confirm it is them before other sessions end. */
export async function startStaffReauth(
  deps: StaffReauthDeps,
  who: ReauthOwner,
  caller: Caller,
): Promise<StaffReauthStart> {
  const opened = await openReauth(deps, who);
  if (opened.kind !== "opened") {
    say(deps, caller, "staff.reauth_throttled", {});
    return opened;
  }
  try {
    await deps.email.send({
      to: who.email,
      ...reauthCodeEmail({ code: opened.code, expiresInMinutes: STAFF_REAUTH_SECONDS / 60 }),
    });
  } catch (error) {
    say(deps, caller, "staff.email_unavailable", { reason: reasonOf(error) });
    return { kind: "email_unavailable" };
  }
  say(deps, caller, "staff.reauth_code_sent", {});
  return {
    kind: "code_sent",
    challengeToken: opened.token,
    expiresInSeconds: STAFF_REAUTH_SECONDS,
  };
}

/** A confirmed code always carries the session's new freshness (migration 0155). */
type ConfirmRow =
  | Readonly<{ outcome: "confirmed"; attempts_left: number; fresh_until: Date }>
  | Readonly<{ outcome: "expired" | "wrong"; attempts_left: number; fresh_until: null }>;

/**
 * Confirms the session's code (`confirm_staff_reauth`): the session is fresh for 10 minutes. A wrong code also counts
 * in the staff sign-in failure windows, in the same transaction, so it spends the budget of the sign-in guesses.
 */
export async function confirmStaffReauth(
  deps: StaffReauthDeps,
  who: ReauthOwner,
  input: Readonly<{ challengeToken: string; code: string; requestId: string }>,
  caller: Caller,
): Promise<StaffReauthConfirm> {
  const tokenHash = hashToken(input.challengeToken);
  const row = await asUser(deps.pool, who.staffUserId, async (client) => {
    const { rows } = await client.query<ConfirmRow>(
      "SELECT * FROM confirm_staff_reauth(decode($1, 'hex'), decode($2, 'hex'), $3, $4)",
      [who.tokenHash, tokenHash, codeHashOf(deps.keys, tokenHash, input.code), input.requestId],
    );
    if (rows[0]?.outcome === "wrong") {
      await recordFailure(client, keysFor(deps, who.email, caller));
    }
    return rows[0];
  });
  if (row?.outcome === "confirmed") {
    return { kind: "confirmed", freshUntil: row.fresh_until };
  }
  if (row?.outcome === "wrong") {
    return { kind: "invalid_code", attemptsLeft: row.attempts_left };
  }
  return { kind: "challenge_expired" };
}

export type StaffReauth = Readonly<{
  start: (who: ReauthOwner, caller: Caller) => Promise<StaffReauthStart>;
  confirm: (
    who: ReauthOwner,
    input: Readonly<{ challengeToken: string; code: string; requestId: string }>,
    caller: Caller,
  ) => Promise<StaffReauthConfirm>;
}>;

/** The staff re-authentication service the routes call. */
export function createStaffReauth(deps: StaffReauthDeps): StaffReauth {
  return {
    start: (who, caller) => startStaffReauth(deps, who, caller),
    confirm: (who, input, caller) => confirmStaffReauth(deps, who, input, caller),
  };
}
