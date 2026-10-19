import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { recordAudit } from "#src/audit/record";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { withPreIdentityContext } from "#src/db/pre-identity";
import type { EmailSender } from "#src/auth/email/sender";
import { newSignInAlertEmail, signInCodeEmail } from "#src/auth/email/templates";
import { generateCode, generateToken, hashToken, safeEqual, type AuthKeys } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import {
  addressBucket,
  codePointLength,
  isPlausibleEmail,
  normalizeEmail,
} from "#src/auth/normalize";
import {
  MAX_PASSWORD_LENGTH,
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "#src/auth/password";
import {
  deleteOwnChallenges,
  bumpAttempts,
  capLiveSessions,
  consumeChallenge,
  findAccountByEmail,
  insertChallenge,
  insertSession,
  killChallenge,
  lockChallenge,
  readAccount,
  replaceCode,
  setPasswordHash,
  sweepRetention,
  type Account,
  type PublicAccount,
} from "#src/auth/staff-store";
import { BUCKETS, countRecent, forget, record, sweepThrottle, tryLock } from "#src/auth/throttle";
import { GateBusyError, type VerifyGate } from "#src/auth/verify-gate";

export type AuthLog = (event: string, fields?: Readonly<Record<string, string | number>>) => void;

export type SignInDeps = Readonly<{
  pool: Pool;
  keys: AuthKeys;
  email: EmailSender;
  gate: VerifyGate;
  /** Told about every new platform-admin session, besides the admin's own mailbox. */
  securityAlertEmail: string | undefined;
}>;

/** Who is asking: the client address and browser, kept on the session so the person can recognise it. */
export type Caller = Readonly<{
  address: string;
  userAgent: string | null;
  /** Writes an event to the request's own log, so it carries the request id. */
  log: AuthLog;
  /** The request id, so an audit entry can be traced to its request. */
  requestId?: string | undefined;
}>;

export type Throttled = Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

export type PasswordResult =
  | Readonly<{ kind: "code_sent"; challengeToken: string; expiresInSeconds: number }>
  | Readonly<{ kind: "invalid_credentials" }>
  | Throttled
  | Readonly<{ kind: "challenge_cap"; retryAfterSeconds: number }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "email_unavailable" }>;

export type CodeResult =
  | Readonly<{ kind: "signed_in"; sessionToken: string; account: PublicAccount }>
  | Readonly<{ kind: "invalid_code"; attemptsLeft: number }>
  | Readonly<{ kind: "challenge_expired" }>
  | Throttled;

export type ResendResult =
  | Readonly<{ kind: "resent" }>
  | Readonly<{ kind: "challenge_expired" }>
  | Readonly<{ kind: "resend_too_soon"; retryAfterSeconds: number }>
  | Readonly<{ kind: "resend_limit" }>
  | Readonly<{ kind: "email_unavailable" }>;

export type SignIn = Readonly<{
  passwordStep: (
    input: { email: string; password: string },
    caller: Caller,
  ) => Promise<PasswordResult>;
  codeStep: (
    input: { challengeToken: string; code: string },
    caller: Caller,
  ) => Promise<CodeResult>;
  resend: (input: { challengeToken: string }, caller: Caller) => Promise<ResendResult>;
}>;

const L = AUTH_LIMITS;
const EXPIRES_IN_MINUTES = L.challengeValiditySeconds / 60;

/** Logs an event with a short keyed tag of the client address (never the address), so abuse can be told apart. */
function say(
  deps: SignInDeps,
  caller: Caller,
  event: string,
  fields: Readonly<Record<string, string | number>> = {},
): void {
  const tag = deps.keys.addressKey(addressBucket(caller.address)).toString("hex").slice(0, 12);
  caller.log(event, { addr: tag, ...fields });
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

type Keys = Readonly<{ email: Buffer; address: Buffer }>;

/** The failure windows for this email and this address; returns how long to wait when either is full. */
async function exceededWindow(client: PoolClient, keys: Keys): Promise<Throttled | undefined> {
  const [byEmail, byAddress] = [
    await countRecent(client, BUCKETS.failEmail, keys.email, L.failuresPerEmail.windowSeconds),
    await countRecent(
      client,
      BUCKETS.failAddress,
      keys.address,
      L.failuresPerAddress.windowSeconds,
    ),
  ];
  if (byEmail.count >= L.failuresPerEmail.max) {
    return { kind: "throttled", retryAfterSeconds: byEmail.retryAfterSeconds };
  }
  if (byAddress.count >= L.failuresPerAddress.max) {
    return { kind: "throttled", retryAfterSeconds: byAddress.retryAfterSeconds };
  }
  return undefined;
}

async function recordFailure(client: PoolClient, keys: Keys): Promise<void> {
  await record(client, BUCKETS.failEmail, keys.email);
  await record(client, BUCKETS.failAddress, keys.address);
}

type Reservation = Readonly<{ emailAt: string; addressAt: string }>;

/** Counts first, then records this attempt as a failure that a success will take back. */
async function reserveAttempt(
  deps: SignInDeps,
  keys: Keys,
): Promise<Throttled | (Reservation & { kind: "reserved" })> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, async () => {
      if (!(await tryLock(client, keys.email))) {
        return { kind: "throttled", retryAfterSeconds: 1 } as const;
      }
      const full = await exceededWindow(client, keys);
      if (full !== undefined) {
        return full;
      }
      return {
        kind: "reserved",
        emailAt: await record(client, BUCKETS.failEmail, keys.email),
        addressAt: await record(client, BUCKETS.failAddress, keys.address),
      } as const;
    }),
  );
}

async function releaseReservation(
  client: PoolClient,
  keys: Keys,
  reservation: Reservation,
): Promise<void> {
  await forget(client, BUCKETS.failEmail, keys.email, reservation.emailAt);
  await forget(client, BUCKETS.failAddress, keys.address, reservation.addressAt);
}

async function lookupAccount(deps: SignInDeps, email: string): Promise<Account | undefined> {
  if (!isPlausibleEmail(email)) {
    return undefined;
  }
  return withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "email", email }, () =>
      findAccountByEmail(client, email),
    ),
  );
}

/** Real accounts and unknown emails both pay for one password check, so timing reveals nothing. */
async function checkPassword(
  deps: SignInDeps,
  account: Account | undefined,
  password: string,
): Promise<Account | "wrong" | "busy"> {
  try {
    return await deps.gate.run(async () => {
      if (account === undefined || account.status !== "active") {
        await dummyVerify(password);
        return "wrong";
      }
      return (await verifyPassword(account.passwordHash, password)) ? account : "wrong";
    });
  } catch (error) {
    if (error instanceof GateBusyError) {
      return "busy";
    }
    throw error;
  }
}

type Opened =
  | Readonly<{ kind: "opened"; challengeToken: string; code: string }>
  | Readonly<{ kind: "challenge_cap"; retryAfterSeconds: number }>;

/** Takes back the reserved failure, applies the hourly challenge cap, and replaces the user's challenge. */
async function openChallenge(
  deps: SignInDeps,
  account: Account,
  keys: Keys,
  reservation: Reservation,
): Promise<Opened> {
  return withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "email", email: account.email }, async ({ promote }) => {
      await promote(account.id);
      await releaseReservation(client, keys, reservation);
      const userKey = deps.keys.userKey(account.id);
      if (!(await tryLock(client, userKey))) {
        return { kind: "challenge_cap", retryAfterSeconds: 1 } as const;
      }
      const recent = await countRecent(
        client,
        BUCKETS.challengeUser,
        userKey,
        L.challengesPerUser.windowSeconds,
      );
      if (recent.count >= L.challengesPerUser.max) {
        return { kind: "challenge_cap", retryAfterSeconds: recent.retryAfterSeconds } as const;
      }
      await record(client, BUCKETS.challengeUser, userKey);
      await deleteOwnChallenges(client);
      const token = generateToken();
      const code = generateCode();
      const id = randomUUID();
      await insertChallenge(client, {
        id,
        staffUserId: account.id,
        tokenHash: token.hash,
        codeHash: deps.keys.codeHash(id, code),
        validForSeconds: L.challengeValiditySeconds,
      });
      return { kind: "opened", challengeToken: token.token, code } as const;
    }),
  );
}

/** Ends the challenge a token opens. Used when its code could not be emailed. */
async function endChallenge(deps: SignInDeps, challengeToken: string): Promise<void> {
  await withConnection(deps.pool, (client) =>
    withPreIdentityContext(
      client,
      { kind: "challenge", tokenHash: hashToken(challengeToken) },
      () => killChallenge(client),
    ),
  );
}

/** Sends the code. If no sender takes it, the challenge is ended so the person starts over. */
async function deliverCode(
  deps: SignInDeps,
  caller: Caller,
  to: string,
  code: string,
  challengeToken: string,
): Promise<boolean> {
  try {
    await deps.email.send({
      to,
      ...signInCodeEmail({ code, expiresInMinutes: EXPIRES_IN_MINUTES }),
    });
    return true;
  } catch (error) {
    say(deps, caller, "staff.email_unavailable", { reason: reasonOf(error) });
    await endChallenge(deps, challengeToken);
    return false;
  }
}

/** Makes the stored hash current when the parameters changed. A failure is logged and never blocks sign-in. */
async function refreshHash(
  deps: SignInDeps,
  caller: Caller,
  account: Account,
  password: string,
): Promise<void> {
  if (!needsRehash(account.passwordHash)) {
    return;
  }
  try {
    const fresh = await deps.gate.run(() => hashPassword(password));
    await withConnection(deps.pool, (client) =>
      withPreIdentityContext(
        client,
        { kind: "email", email: account.email },
        async ({ promote }) => {
          await promote(account.id);
          await setPasswordHash(client, account.id, fresh);
        },
      ),
    );
  } catch (error) {
    say(deps, caller, "staff.rehash_failed", { reason: reasonOf(error) });
  }
}

/** Remembers when the retention sweep last ran, so it runs at most every ten minutes per service. */
type SweepClock = { last: number };

/** Removes old sessions, challenges and throttle rows. Best effort: a failure is logged and never blocks sign-in. */
async function sweepIfDue(deps: SignInDeps, caller: Caller, clock: SweepClock): Promise<void> {
  // Stryker disable next-line EqualityOperator: equivalent: a millisecond boundary on the wall clock
  if (Date.now() - clock.last < L.sweepIntervalMs) {
    return;
  }
  try {
    await withConnection(deps.pool, (client) =>
      withRequestContext(client, {}, async () => {
        await sweepRetention(client);
        await sweepThrottle(client);
      }),
    );
    clock.last = Date.now();
  } catch (error) {
    say(deps, caller, "staff.sweep_failed", { reason: reasonOf(error) });
  }
}

function keysFor(deps: SignInDeps, email: string, caller: Caller): Keys {
  return {
    email: deps.keys.emailKey(email),
    address: deps.keys.addressKey(addressBucket(caller.address)),
  };
}

async function passwordStep(
  deps: SignInDeps,
  clock: SweepClock,
  input: { email: string; password: string },
  caller: Caller,
): Promise<PasswordResult> {
  const email = normalizeEmail(input.email);
  if (codePointLength(input.password) > MAX_PASSWORD_LENGTH) {
    return { kind: "invalid_credentials" };
  }
  const keys = keysFor(deps, email, caller);
  const reservation = await reserveAttempt(deps, keys);
  if (reservation.kind === "throttled") {
    say(deps, caller, "staff.throttled", { step: "password" });
    return reservation;
  }
  const verdict = await checkPassword(deps, await lookupAccount(deps, email), input.password);
  if (verdict === "busy") {
    await withConnection(deps.pool, (client) =>
      withRequestContext(client, {}, () => releaseReservation(client, keys, reservation)),
    );
    return { kind: "busy" };
  }
  if (verdict === "wrong") {
    say(deps, caller, "staff.password_failed");
    return { kind: "invalid_credentials" };
  }
  const account = verdict;
  const opened = await openChallenge(deps, account, keys, reservation);
  if (opened.kind === "challenge_cap") {
    say(deps, caller, "staff.throttled", { step: "challenge_cap" });
    return opened;
  }
  say(deps, caller, "staff.password_ok", { user: account.id });
  await sweepIfDue(deps, caller, clock);
  await refreshHash(deps, caller, account, input.password);
  if (!(await deliverCode(deps, caller, account.email, opened.code, opened.challengeToken))) {
    return { kind: "email_unavailable" };
  }
  return {
    kind: "code_sent",
    challengeToken: opened.challengeToken,
    expiresInSeconds: L.challengeValiditySeconds,
  };
}

type Judged = CodeResult | Readonly<{ kind: "ok"; account: PublicAccount }>;

/** Checks one code guess inside the locked challenge. Wrong guesses are recorded and returned, not thrown. */
async function judgeCode(
  deps: SignInDeps,
  client: PoolClient,
  challenge: NonNullable<Awaited<ReturnType<typeof lockChallenge>>>,
  account: PublicAccount,
  code: string,
  caller: Caller,
): Promise<Judged> {
  const keys = keysFor(deps, account.email, caller);
  if (!(await tryLock(client, keys.email))) {
    return { kind: "throttled", retryAfterSeconds: 1 };
  }
  const full = await exceededWindow(client, keys);
  if (full !== undefined) {
    return full;
  }
  if (!(await bumpAttempts(client, challenge.id))) {
    return { kind: "challenge_expired" };
  }
  if (!safeEqual(deps.keys.codeHash(challenge.id, code), challenge.codeHash)) {
    await recordFailure(client, keys);
    return { kind: "invalid_code", attemptsLeft: L.maxCodeAttempts - (challenge.attempts + 1) };
  }
  return { kind: "ok", account };
}

async function codeStep(
  deps: SignInDeps,
  input: { challengeToken: string; code: string },
  caller: Caller,
): Promise<CodeResult> {
  const tokenHash = hashToken(input.challengeToken);
  const session = generateToken();
  const outcome = await withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "challenge", tokenHash }, async ({ promote }) => {
      const challenge = await lockChallenge(client);
      if (
        challenge === undefined ||
        challenge.consumed ||
        challenge.expired ||
        // Stryker disable next-line ConditionalExpression,EqualityOperator: defence in depth: the bump guard and the check constraint also refuse a sixth attempt
        challenge.attempts >= L.maxCodeAttempts
      ) {
        return { kind: "challenge_expired" } as const;
      }
      await promote(challenge.staffUserId);
      const account = await readAccount(client, challenge.staffUserId);
      // Stryker disable next-line ConditionalExpression: unreachable: a challenge cannot outlive its user (the foreign key cascades)
      if (account === undefined || account.status !== "active") {
        return { kind: "challenge_expired" } as const;
      }
      const judged = await judgeCode(deps, client, challenge, account, input.code, caller);
      if (judged.kind !== "ok") {
        return judged;
      }
      if (!(await consumeChallenge(client, challenge.id))) {
        return { kind: "challenge_expired" } as const;
      }
      const sessionId = await insertSession(client, {
        staffUserId: account.id,
        tokenHash: session.hash,
        userAgent: caller.userAgent,
        ip: caller.address,
      });
      const endedOlder = await capLiveSessions(client, account.id, L.maxLiveSessions);
      await recordAudit(client, {
        actor: { type: "staff", id: account.id },
        action: "staff.session.open",
        target: { type: "staff_session", id: sessionId },
        after: { endedOlderSessions: endedOlder },
        requestId: caller.requestId,
      });
      return { kind: "signed_in", sessionToken: session.token, account } as const;
    }),
  );
  if (outcome.kind === "signed_in") {
    say(deps, caller, "staff.session_opened", { user: outcome.account.id });
    // Not awaited: sending mail must not hold up the sign-in. Failures are caught and logged inside.
    void alertAdminSignIn(deps, outcome.account, caller);
  } else if (outcome.kind === "invalid_code") {
    say(deps, caller, "staff.code_failed", { attemptsLeft: outcome.attemptsLeft });
  } else if (outcome.kind === "throttled") {
    say(deps, caller, "staff.throttled", { step: "code" });
  }
  return outcome;
}

/** Tells a platform admin (and the security mailbox) about a new session. A failed alert is logged, not fatal. */
async function alertAdminSignIn(
  deps: SignInDeps,
  account: PublicAccount,
  caller: Caller,
): Promise<void> {
  if (account.platformRole !== "admin") {
    return;
  }
  const content = newSignInAlertEmail({ at: new Date(), userAgent: caller.userAgent });
  const recipients = [account.email, deps.securityAlertEmail].filter(
    (address): address is string => address !== undefined,
  );
  for (const to of recipients) {
    try {
      await deps.email.send({ to, ...content });
    } catch (error) {
      say(deps, caller, "staff.alert_failed", { reason: reasonOf(error) });
    }
  }
}

type Resending =
  | Exclude<ResendResult, { kind: "resent" | "email_unavailable" }>
  | Readonly<{ kind: "resending"; to: string; code: string }>;

async function resend(
  deps: SignInDeps,
  input: { challengeToken: string },
  caller: Caller,
): Promise<ResendResult> {
  const tokenHash = hashToken(input.challengeToken);
  const prepared = await withConnection(deps.pool, (client) =>
    withPreIdentityContext(
      client,
      { kind: "challenge", tokenHash },
      async ({ promote }): Promise<Resending> => {
        const challenge = await lockChallenge(client);
        if (
          challenge === undefined ||
          challenge.consumed ||
          challenge.expired ||
          // Stryker disable next-line ConditionalExpression,EqualityOperator: defence in depth: the bump guard and the check constraint also refuse a sixth attempt
          challenge.attempts >= L.maxCodeAttempts
        ) {
          return { kind: "challenge_expired" };
        }
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: defence in depth: replaceCode also refuses a fourth resend and the caller maps that to the same answer
        if (challenge.resends >= L.maxResends) {
          return { kind: "resend_limit" };
        }
        // Stryker disable next-line EqualityOperator: equivalent: fractional seconds from the database clock are never exactly 60
        if (challenge.secondsSinceSent < L.resendSpacingSeconds) {
          return {
            kind: "resend_too_soon",
            retryAfterSeconds: Math.ceil(L.resendSpacingSeconds - challenge.secondsSinceSent),
          };
        }
        await promote(challenge.staffUserId);
        const account = await readAccount(client, challenge.staffUserId);
        // Stryker disable next-line ConditionalExpression: unreachable: a challenge cannot outlive its user (the foreign key cascades)
        if (account === undefined || account.status !== "active") {
          return { kind: "challenge_expired" };
        }
        const code = generateCode();
        if (!(await replaceCode(client, challenge.id, deps.keys.codeHash(challenge.id, code)))) {
          return { kind: "resend_limit" };
        }
        return { kind: "resending", to: account.email, code };
      },
    ),
  );
  if (prepared.kind !== "resending") {
    return prepared;
  }
  return (await deliverCode(deps, caller, prepared.to, prepared.code, input.challengeToken))
    ? { kind: "resent" }
    : { kind: "email_unavailable" };
}

/** The staff sign-in flow: password, then the emailed code, with every failure returned as a value. */
export function createSignIn(deps: SignInDeps): SignIn {
  // Stryker disable next-line ObjectLiteral: equivalent: an undefined start makes the first comparison NaN, which also means 'sweep now'
  const clock: SweepClock = { last: 0 };
  return {
    passwordStep: (input, caller) => passwordStep(deps, clock, input, caller),
    codeStep: (input, caller) => codeStep(deps, input, caller),
    resend: (input, caller) => resend(deps, input, caller),
  };
}
