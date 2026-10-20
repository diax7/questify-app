import type { PoolClient } from "pg";
import { recordAudit } from "#src/audit/record";
import { BreachCheckUnavailable, type BreachCheck } from "#src/auth/breached";
import type { Deferred } from "#src/auth/deferred";
import { passwordChangedEmail, passwordResetEmail } from "#src/auth/email/templates";
import { generateToken, hashToken } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import { addressBucket, isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import {
  checkPasswordPolicy,
  dummyVerify,
  hashPassword,
  verifyPassword,
  type PolicyReason,
} from "#src/auth/password";
import {
  keysFor,
  reasonOf,
  releaseReservation,
  reserveAttempt,
  say,
  type Caller,
  type SignInDeps,
  type Throttled,
} from "#src/auth/sign-in";
import {
  consumeResetLink,
  deleteOwnChallenges,
  deleteOwnResetLinks,
  findAccountByEmail,
  findResetLink,
  insertResetLink,
  readAccount,
  revokeUserSessions,
  setPasswordHash,
  type PublicAccount,
} from "#src/auth/staff-store";
import { BUCKETS, clearKey, countRecent, record, tryLock } from "#src/auth/throttle";
import { GateBusyError } from "#src/auth/verify-gate";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { withPreIdentityContext } from "#src/db/pre-identity";

/** Why a new password was refused: the length and context rules, or a known breach. */
export type WeakReason = PolicyReason | "breached";

export type PasswordDeps = SignInDeps &
  Readonly<{
    breachCheck: BreachCheck;
    /** Runs the reset email after the answer has gone, so timing says nothing about the account. */
    deferred: Deferred;
    dashboardOrigin: string;
  }>;

type Weak = Readonly<{ kind: "weak"; reason: WeakReason }>;
type NotSet = Weak | Readonly<{ kind: "breach_unavailable" }> | Readonly<{ kind: "busy" }>;

export type RequestResult = Readonly<{ kind: "accepted" }> | Throttled;
export type ConfirmResult =
  | Readonly<{ kind: "reset" }>
  | Readonly<{ kind: "link_invalid" }>
  | NotSet
  | Throttled;
export type ChangeResult =
  | Readonly<{ kind: "changed" }>
  | Readonly<{ kind: "current_wrong" }>
  | NotSet
  | Throttled;

export type Passwords = Readonly<{
  requestReset: (
    input: { email: string; lang: "ar" | "en" },
    caller: Caller,
  ) => Promise<RequestResult>;
  confirmReset: (
    input: { token: string; newPassword: string },
    caller: Caller,
  ) => Promise<ConfirmResult>;
  change: (
    input: { currentPassword: string; newPassword: string },
    who: Readonly<{ account: PublicAccount; sessionId: string }>,
    caller: Caller,
  ) => Promise<ChangeResult>;
}>;

const L = AUTH_LIMITS;

/** Counts and records one reset request per email and per address, before the answer, for every email. */
async function admitResetRequest(
  deps: PasswordDeps,
  email: string,
  caller: Caller,
): Promise<Throttled | undefined> {
  const emailKey = deps.keys.emailKey(email);
  const addressKey = deps.keys.addressKey(addressBucket(caller.address));
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, async () => {
      if (!(await tryLock(client, emailKey))) {
        return { kind: "throttled", retryAfterSeconds: 1 } as const;
      }
      const windows = [
        await countRecent(
          client,
          BUCKETS.resetEmail,
          emailKey,
          L.resetRequestsPerEmail.windowSeconds,
        ),
        await countRecent(
          client,
          BUCKETS.resetAddress,
          addressKey,
          L.resetRequestsPerAddress.windowSeconds,
        ),
      ];
      const limits = [L.resetRequestsPerEmail.max, L.resetRequestsPerAddress.max];
      const full = windows.find((window, index) => window.count >= (limits[index] ?? 0));
      if (full !== undefined) {
        return { kind: "throttled", retryAfterSeconds: full.retryAfterSeconds } as const;
      }
      await record(client, BUCKETS.resetEmail, emailKey);
      await record(client, BUCKETS.resetAddress, addressKey);
      return undefined;
    }),
  );
}

/** Opens a fresh link for an active account (replacing older ones) and emails it. Runs after the answer. */
async function sendResetLink(
  deps: PasswordDeps,
  email: string,
  lang: "ar" | "en",
  caller: Caller,
): Promise<void> {
  try {
    if (!isPlausibleEmail(email)) {
      return;
    }
    const opened = await withConnection(deps.pool, (client) =>
      withPreIdentityContext(client, { kind: "email", email }, async ({ promote }) => {
        const account = await findAccountByEmail(client, email);
        if (account === undefined || account.status !== "active") {
          return undefined;
        }
        await promote(account.id);
        await deleteOwnResetLinks(client);
        const token = generateToken();
        await insertResetLink(client, {
          staffUserId: account.id,
          tokenHash: token.hash,
          validForSeconds: L.resetValiditySeconds,
        });
        return { id: account.id, to: account.email, token: token.token };
      }),
    );
    if (opened === undefined) {
      return;
    }
    const link = `${deps.dashboardOrigin}/${lang}/reset-password#token=${opened.token}`;
    try {
      await deps.email.send({
        to: opened.to,
        ...passwordResetEmail({ link, expiresInMinutes: L.resetValiditySeconds / 60 }),
      });
      say(deps, caller, "staff.reset_sent", { user: opened.id });
    } catch (error) {
      say(deps, caller, "staff.reset_email_unavailable", { reason: reasonOf(error) });
    }
  } catch (error) {
    say(deps, caller, "staff.reset_failed", { reason: reasonOf(error) });
  }
}

async function requestReset(
  deps: PasswordDeps,
  input: { email: string; lang: "ar" | "en" },
  caller: Caller,
): Promise<RequestResult> {
  const email = normalizeEmail(input.email);
  const throttled = await admitResetRequest(deps, email, caller);
  if (throttled !== undefined) {
    say(deps, caller, "staff.throttled", { step: "reset_request" });
    return throttled;
  }
  deps.deferred.defer(() => sendResetLink(deps, email, input.lang, caller));
  return { kind: "accepted" };
}

type Ready = Readonly<{ kind: "ready"; hash: string }>;

/** The breach check and the hash, both outside any transaction (a network call must never hold a row lock). */
async function breachCheckAndHash(
  deps: PasswordDeps,
  password: string,
  caller: Caller,
): Promise<Ready | NotSet> {
  try {
    if (await deps.breachCheck(password)) {
      return { kind: "weak", reason: "breached" };
    }
  } catch (error) {
    if (error instanceof BreachCheckUnavailable) {
      say(deps, caller, "staff.breach_check_unavailable", { reason: error.name });
      return { kind: "breach_unavailable" };
    }
    throw error;
  }
  try {
    return { kind: "ready", hash: await deps.gate.run(() => hashPassword(password)) };
  } catch (error) {
    if (error instanceof GateBusyError) {
      return { kind: "busy" };
    }
    throw error;
  }
}

/** The new password's checks in order: the rules, then the breach list, then the hash. */
async function prepare(
  deps: PasswordDeps,
  password: string,
  email: string,
  caller: Caller,
): Promise<Ready | NotSet> {
  const policy = checkPasswordPolicy(password, email);
  if (!policy.ok) {
    return { kind: "weak", reason: policy.reason };
  }
  return breachCheckAndHash(deps, password, caller);
}

/**
 * Inside the caller's transaction, as the user: sets the hash, ends sessions (all, or all but `keep`), and removes
 * the user's sign-in challenges and reset links. Audited without any secret.
 */
async function applyNewPassword(
  client: PoolClient,
  account: PublicAccount,
  hash: string,
  how: Readonly<{ action: string; keep?: string; requestId: string | undefined }>,
): Promise<void> {
  await setPasswordHash(client, account.id, hash);
  const sessionsEnded = await revokeUserSessions(client, account.id, how.keep);
  await deleteOwnChallenges(client);
  await deleteOwnResetLinks(client);
  await recordAudit(client, {
    actor: { type: "staff", id: account.id },
    action: how.action,
    target: { type: "staff_user", id: account.id },
    after: { sessionsEnded },
    requestId: how.requestId,
  });
}

/** Tells the person (and the security mailbox, for a platform admin) that the password changed. Runs later. */
function notifyChanged(deps: PasswordDeps, account: PublicAccount, caller: Caller): void {
  deps.deferred.defer(async () => {
    const content = passwordChangedEmail({ at: new Date(), dashboardOrigin: deps.dashboardOrigin });
    const recipients = [account.email];
    if (account.platformRole === "admin" && deps.securityAlertEmail !== undefined) {
      recipients.push(deps.securityAlertEmail);
    }
    for (const to of recipients) {
      try {
        await deps.email.send({ to, ...content });
      } catch (error) {
        say(deps, caller, "staff.password_notice_failed", { reason: reasonOf(error) });
      }
    }
  });
}

type Found =
  | Readonly<{ kind: "found"; account: PublicAccount }>
  | Readonly<{ kind: "unknown" | "expired" | "disabled" }>;

/** Phase A: reads the link and its account. Only an unknown token counts as a failure for the address. */
async function readLink(deps: PasswordDeps, tokenHash: string, address: Buffer): Promise<Found> {
  return withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "reset", tokenHash }, async ({ promote }) => {
      const link = await findResetLink(client);
      if (link === undefined) {
        await record(client, BUCKETS.failAddress, address);
        return { kind: "unknown" } as const;
      }
      if (link.expired) {
        return { kind: "expired" } as const;
      }
      await promote(link.staffUserId);
      const account = await readAccount(client, link.staffUserId);
      // Stryker disable next-line ConditionalExpression: unreachable half: a link cannot outlive its user (the foreign key cascades)
      if (account === undefined || account.status !== "active") {
        return { kind: "disabled" } as const;
      }
      return { kind: "found", account } as const;
    }),
  );
}

/** Phase B: re-reads the account, then uses the link up and sets the password, in one transaction. */
async function useLink(
  deps: PasswordDeps,
  tokenHash: string,
  accountId: string,
  hash: string,
  caller: Caller,
): Promise<PublicAccount | undefined> {
  return withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "reset", tokenHash }, async ({ promote }) => {
      await promote(accountId);
      const account = await readAccount(client, accountId);
      // Stryker disable next-line ConditionalExpression,LogicalOperator: unreachable half: the account cannot vanish while its link exists
      if (account === undefined || account.status !== "active") {
        return undefined;
      }
      const owner = await consumeResetLink(client);
      if (owner === undefined) {
        return undefined;
      }
      // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral: defence in depth: the link was found by the same token in Phase A
      if (owner !== account.id) {
        throw new Error("The reset link's owner changed between its two reads.");
      }
      await applyNewPassword(client, account, hash, {
        action: "staff.password.reset",
        requestId: caller.requestId,
      });
      // The person just proved the mailbox and the old password is gone: an old lockout protects nothing now.
      await clearKey(client, BUCKETS.failEmail, deps.keys.emailKey(account.email));
      await clearKey(client, BUCKETS.challengeUser, deps.keys.userKey(account.id));
      return account;
    }),
  );
}

async function confirmReset(
  deps: PasswordDeps,
  input: { token: string; newPassword: string },
  caller: Caller,
): Promise<ConfirmResult> {
  const tokenHash = hashToken(input.token);
  const address = deps.keys.addressKey(addressBucket(caller.address));
  // A soft limit under concurrency (the count and the failure record are separate transactions); tokens are 256-bit,
  // so this only slows a flood, it is not what stops guessing.
  const window = await withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, () =>
      countRecent(client, BUCKETS.failAddress, address, L.failuresPerAddress.windowSeconds),
    ),
  );
  if (window.count >= L.failuresPerAddress.max) {
    say(deps, caller, "staff.throttled", { step: "reset_confirm" });
    return { kind: "throttled", retryAfterSeconds: window.retryAfterSeconds };
  }
  const found = await readLink(deps, tokenHash, address);
  if (found.kind !== "found") {
    say(deps, caller, "staff.reset_link_invalid", { why: found.kind });
    return { kind: "link_invalid" };
  }
  const prepared = await prepare(deps, input.newPassword, found.account.email, caller);
  if (prepared.kind !== "ready") {
    return prepared;
  }
  const account = await useLink(deps, tokenHash, found.account.id, prepared.hash, caller);
  if (account === undefined) {
    say(deps, caller, "staff.reset_link_invalid", { why: "used" });
    return { kind: "link_invalid" };
  }
  say(deps, caller, "staff.password_reset", { user: account.id });
  notifyChanged(deps, account, caller);
  return { kind: "reset" };
}

/** Checks the current password through the verify gate; a disabled or missing account pays the same price. */
async function currentPasswordIs(
  deps: PasswordDeps,
  email: string,
  password: string,
): Promise<boolean> {
  const stored = await withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "email", email }, () =>
      findAccountByEmail(client, email),
    ),
  );
  return deps.gate.run(async () => {
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: unreachable: the session hook already refused a missing or disabled account
    if (stored === undefined || stored.status !== "active") {
      await dummyVerify(password);
      return false;
    }
    return verifyPassword(stored.passwordHash, password);
  });
}

async function change(
  deps: PasswordDeps,
  input: { currentPassword: string; newPassword: string },
  who: Readonly<{ account: PublicAccount; sessionId: string }>,
  caller: Caller,
): Promise<ChangeResult> {
  const { account } = who;
  const policy = checkPasswordPolicy(input.newPassword, account.email);
  if (!policy.ok) {
    return { kind: "weak", reason: policy.reason };
  }
  const keys = keysFor(deps, account.email, caller);
  const reservation = await reserveAttempt(deps, keys);
  if (reservation.kind === "throttled") {
    say(deps, caller, "staff.throttled", { step: "password_change" });
    return reservation;
  }
  let right: boolean;
  try {
    right = await currentPasswordIs(deps, account.email, input.currentPassword);
  } catch (error) {
    if (!(error instanceof GateBusyError)) {
      throw error;
    }
    await withConnection(deps.pool, (client) =>
      withRequestContext(client, {}, () => releaseReservation(client, keys, reservation)),
    );
    return { kind: "busy" };
  }
  if (!right) {
    say(deps, caller, "staff.password_change_failed", { user: account.id });
    return { kind: "current_wrong" };
  }
  await withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, () => releaseReservation(client, keys, reservation)),
  );
  const prepared = await breachCheckAndHash(deps, input.newPassword, caller);
  if (prepared.kind !== "ready") {
    return prepared;
  }
  await withConnection(deps.pool, (client) =>
    withRequestContext(client, { staffUserId: account.id }, () =>
      applyNewPassword(client, account, prepared.hash, {
        action: "staff.password.change",
        keep: who.sessionId,
        requestId: caller.requestId,
      }),
    ),
  );
  say(deps, caller, "staff.password_changed", { user: account.id });
  notifyChanged(deps, account, caller);
  return { kind: "changed" };
}

/** Password reset by emailed link, and password change for a signed-in person (T-020). */
export function createPasswords(deps: PasswordDeps): Passwords {
  return {
    requestReset: (input, caller) => requestReset(deps, input, caller),
    confirmReset: (input, caller) => confirmReset(deps, input, caller),
    change: (input, who, caller) => change(deps, input, who, caller),
  };
}
