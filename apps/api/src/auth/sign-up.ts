import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { missingAcceptances, type Acceptance, type OrganizerDocumentId } from "@questify/shared";
import { alreadyHaveAccountEmail, signUpCodeEmail } from "#src/auth/email/templates";
import { generateCode, generateToken, hashToken, safeEqual } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import { isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import { takeOutboundMail } from "#src/auth/outbound";
import { checkPasswordPolicy } from "#src/auth/password";
import { breachCheckAndHash, type NotSet, type PasswordDeps } from "#src/auth/password-reset";
import {
  exceededWindow,
  keysFor,
  openSession,
  reasonOf,
  recordFailure,
  say,
  type Caller,
  type ResendResult,
  type Throttled,
} from "#src/auth/sign-in";
import {
  bumpSignupAttempts,
  completeSignup,
  createOrganizer,
  deleteSignup,
  insertSignup,
  lockSignup,
  replaceSignupCode,
  withFreshSlug,
  type PendingSignup,
} from "#src/auth/signup-store";
import { findAccountByEmail, type PublicAccount } from "#src/auth/staff-store";
import { BUCKETS, countRecent, record, tryLock } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { withPreIdentityContext } from "#src/db/pre-identity";
import { checkOrganizerName, slugFor, type NameCheck } from "#src/organizers/naming";

type NameRefused = Readonly<{
  kind: "invalid_name";
  reason: Extract<NameCheck, { ok: false }>["reason"];
}>;
type AcceptanceMissing = Readonly<{
  kind: "acceptance_required";
  documents: readonly OrganizerDocumentId[];
}>;

export type SignUpInput = Readonly<{
  email: string;
  password: string;
  organizerName: string;
  accept: Acceptance;
}>;

export type StartResult =
  | Readonly<{ kind: "code_sent"; challengeToken: string; expiresInSeconds: number }>
  | Readonly<{ kind: "invalid_email" }>
  | NameRefused
  | AcceptanceMissing
  | NotSet
  | Throttled
  | Readonly<{ kind: "email_unavailable" }>;

export type SignUpCodeResult =
  | Readonly<{
      kind: "signed_up";
      sessionToken: string;
      account: PublicAccount;
      organizerId: string;
    }>
  | Readonly<{ kind: "invalid_code"; attemptsLeft: number }>
  | Readonly<{ kind: "challenge_expired" }>
  | Throttled;

export type CreateResult =
  | Readonly<{ kind: "created"; organizerId: string }>
  | NameRefused
  | AcceptanceMissing
  | Throttled;

export type SignUp = Readonly<{
  start: (input: SignUpInput, caller: Caller) => Promise<StartResult>;
  code: (
    input: { challengeToken: string; code: string },
    caller: Caller,
  ) => Promise<SignUpCodeResult>;
  resend: (input: { challengeToken: string }, caller: Caller) => Promise<ResendResult>;
  createOrganizer: (
    input: { name: string; accept: Acceptance },
    account: PublicAccount,
    caller: Caller,
  ) => Promise<CreateResult>;
}>;

const L = AUTH_LIMITS;
const EXPIRES_IN_MINUTES = L.challengeValiditySeconds / 60;
const UNIQUE_VIOLATION = "23505";
const EMAIL_INDEX = "staff_user_email_key";

/** The checks that need no database: the name and the three acceptances. */
function checkForm(name: string, accept: Acceptance): NameRefused | AcceptanceMissing | string {
  const checked = checkOrganizerName(name);
  if (!checked.ok) {
    return { kind: "invalid_name", reason: checked.reason };
  }
  const missing = missingAcceptances(accept);
  return missing.length > 0 ? { kind: "acceptance_required", documents: missing } : checked.name;
}

/** Counts and records one sign-up per email and per address, before anything else, for every email. */
async function admitSignup(
  deps: PasswordDeps,
  email: string,
  caller: Caller,
): Promise<Throttled | undefined> {
  const keys = keysFor(deps, email, caller);
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, async () => {
      if (!(await tryLock(client, keys.email))) {
        return { kind: "throttled", retryAfterSeconds: 1 } as const;
      }
      const byEmail = await countRecent(
        client,
        BUCKETS.signupEmail,
        keys.email,
        L.signupsPerEmail.windowSeconds,
      );
      const byAddress = await countRecent(
        client,
        BUCKETS.signupAddress,
        keys.address,
        L.signupsPerAddress.windowSeconds,
      );
      if (byEmail.count >= L.signupsPerEmail.max) {
        return { kind: "throttled", retryAfterSeconds: byEmail.retryAfterSeconds } as const;
      }
      if (byAddress.count >= L.signupsPerAddress.max) {
        return { kind: "throttled", retryAfterSeconds: byAddress.retryAfterSeconds } as const;
      }
      await record(client, BUCKETS.signupEmail, keys.email);
      await record(client, BUCKETS.signupAddress, keys.address);
      return undefined;
    }),
  );
}

async function accountExists(deps: PasswordDeps, email: string): Promise<boolean> {
  const account = await withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "email", email }, () =>
      findAccountByEmail(client, email),
    ),
  );
  return account !== undefined;
}

/**
 * Emails the code, or (no code: the email already has an account) the note that says so. False when no sender took it.
 */
async function deliver(
  deps: PasswordDeps,
  caller: Caller,
  to: string,
  code: string | undefined,
): Promise<boolean> {
  try {
    await deps.email.send({
      to,
      ...(code === undefined
        ? alreadyHaveAccountEmail({ dashboardOrigin: deps.dashboardOrigin })
        : signUpCodeEmail({ code, expiresInMinutes: EXPIRES_IN_MINUTES })),
    });
    return true;
  } catch (error) {
    say(deps, caller, "staff.email_unavailable", { reason: reasonOf(error) });
    return false;
  }
}

/** Ends a pending sign-up whose email could not be sent, so the person starts over. */
async function dropSignup(deps: PasswordDeps, tokenHash: string): Promise<void> {
  await withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "signup", tokenHash }, () => deleteSignup(client)),
  );
}

/**
 * Step 1. Both branches (a new email, an email that already has an account) pass the same checks, pay for the same
 * password hash and answer the same way; only the email they send differs, and only its owner reads it.
 */
async function start(deps: PasswordDeps, input: SignUpInput, caller: Caller): Promise<StartResult> {
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) {
    return { kind: "invalid_email" };
  }
  const form = checkForm(input.organizerName, input.accept);
  if (typeof form !== "string") {
    return form;
  }
  const policy = checkPasswordPolicy(input.password, email);
  if (!policy.ok) {
    return { kind: "weak", reason: policy.reason };
  }
  const throttled = await admitSignup(deps, email, caller);
  if (throttled !== undefined) {
    say(deps, caller, "staff.throttled", { step: "sign_up" });
    return throttled;
  }
  const prepared = await breachCheckAndHash(deps, input.password, caller);
  if (prepared.kind !== "ready") {
    return prepared;
  }
  const existing = await accountExists(deps, email);
  if (!(await takeOutboundMail(deps.pool))) {
    say(deps, caller, "staff.outbound_cap", { step: "sign_up" });
    return { kind: "email_unavailable" };
  }
  const id = randomUUID();
  const token = generateToken();
  const code = generateCode();
  await withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "signup", tokenHash: token.hash }, () =>
      insertSignup(client, {
        id,
        tokenHash: token.hash,
        codeHash: deps.keys.codeHash(id, code),
        email,
        passwordHash: existing ? null : prepared.hash,
        organizerName: form,
        accepted: input.accept,
        validForSeconds: L.challengeValiditySeconds,
      }),
    ),
  );
  if (!(await deliver(deps, caller, email, existing ? undefined : code))) {
    await dropSignup(deps, token.hash);
    return { kind: "email_unavailable" };
  }
  say(deps, caller, "staff.sign_up_started");
  return {
    kind: "code_sent",
    challengeToken: token.token,
    expiresInSeconds: L.challengeValiditySeconds,
  };
}

type Judged = SignUpCodeResult | Readonly<{ kind: "ok"; typed: Buffer }>;

/** Checks one code guess inside the locked sign-up. Wrong guesses are recorded and returned, not thrown. */
async function judge(
  deps: PasswordDeps,
  client: PoolClient,
  pending: PendingSignup,
  code: string,
  caller: Caller,
): Promise<Judged> {
  const keys = keysFor(deps, pending.email, caller);
  if (!(await tryLock(client, keys.email))) {
    return { kind: "throttled", retryAfterSeconds: 1 };
  }
  const full = await exceededWindow(client, keys);
  if (full !== undefined) {
    return full;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,ObjectLiteral,StringLiteral: defence in depth: the locked row was checked for attempts left a moment ago
  if (!(await bumpSignupAttempts(client, pending.id))) {
    return { kind: "challenge_expired" };
  }
  const typed = deps.keys.codeHash(pending.id, code);
  if (!safeEqual(typed, pending.codeHash) || !pending.completable) {
    await recordFailure(client, keys);
    return { kind: "invalid_code", attemptsLeft: L.maxCodeAttempts - (pending.attempts + 1) };
  }
  return { kind: "ok", typed };
}

/** Step 2: the emailed code. A right code creates the account and its organizer and opens a session. */
async function codeStep(
  deps: PasswordDeps,
  input: { challengeToken: string; code: string },
  caller: Caller,
): Promise<SignUpCodeResult> {
  const tokenHash = hashToken(input.challengeToken);
  const session = generateToken();
  let outcome: SignUpCodeResult;
  try {
    outcome = await withConnection(deps.pool, (client) =>
      withPreIdentityContext(client, { kind: "signup", tokenHash }, async ({ promote }) => {
        const pending = await lockSignup(client);
        // Stryker disable next-line ConditionalExpression,EqualityOperator: defence in depth: the bump guard and the check constraint also refuse a sixth attempt
        if (pending === undefined || pending.expired || pending.attempts >= L.maxCodeAttempts) {
          return { kind: "challenge_expired" } as const;
        }
        const judged = await judge(deps, client, pending, input.code, caller);
        if (judged.kind !== "ok") {
          return judged;
        }
        const created = await withFreshSlug(
          client,
          () => slugFor(pending.organizerName),
          (slug) => completeSignup(client, slug, judged.typed, caller.requestId),
        );
        await promote(created.staffUserId);
        await openSession(client, created.staffUserId, session.hash, caller);
        return {
          kind: "signed_up",
          sessionToken: session.token,
          account: {
            id: created.staffUserId,
            email: pending.email,
            status: "active",
            platformRole: "none",
          },
          organizerId: created.organizerId,
        } as const;
      }),
    );
  } catch (error) {
    // Someone created an account with this email between the two steps.
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === UNIQUE_VIOLATION && pg.constraint === EMAIL_INDEX) {
      return { kind: "challenge_expired" };
    }
    throw error;
  }
  if (outcome.kind === "signed_up") {
    say(deps, caller, "staff.signed_up", { user: outcome.account.id });
  } else if (outcome.kind === "invalid_code") {
    say(deps, caller, "staff.code_failed", { attemptsLeft: outcome.attemptsLeft, step: "sign_up" });
  }
  return outcome;
}

type Resending =
  | Exclude<ResendResult, { kind: "resent" | "email_unavailable" }>
  | Readonly<{ kind: "resending"; to: string; code: string; existing: boolean }>;

/** A new code (or the "already" note again), with the sign-in resend rules: 3 resends, 60 seconds apart. */
async function resend(
  deps: PasswordDeps,
  input: { challengeToken: string },
  caller: Caller,
): Promise<ResendResult> {
  const tokenHash = hashToken(input.challengeToken);
  // The budget comes first, so a person never spends a resend on an email that cannot go out.
  if (!(await takeOutboundMail(deps.pool))) {
    say(deps, caller, "staff.outbound_cap", { step: "sign_up_resend" });
    return { kind: "email_unavailable" };
  }
  const prepared = await withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "signup", tokenHash }, async (): Promise<Resending> => {
      const pending = await lockSignup(client);
      // Stryker disable next-line ConditionalExpression,EqualityOperator: defence in depth: the bump guard and the check constraint also refuse a sixth attempt
      if (pending === undefined || pending.expired || pending.attempts >= L.maxCodeAttempts) {
        return { kind: "challenge_expired" };
      }
      // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: defence in depth: replaceSignupCode also refuses a fourth resend
      if (pending.resends >= L.maxResends) {
        return { kind: "resend_limit" };
      }
      // Stryker disable next-line EqualityOperator: equivalent: fractional seconds from the database clock are never exactly 60
      if (pending.secondsSinceSent < L.resendSpacingSeconds) {
        return {
          kind: "resend_too_soon",
          retryAfterSeconds: Math.ceil(L.resendSpacingSeconds - pending.secondsSinceSent),
        };
      }
      const code = generateCode();
      // Stryker disable next-line ConditionalExpression,BlockStatement,ObjectLiteral,StringLiteral: defence in depth: the resend count was checked on the locked row a moment ago
      if (!(await replaceSignupCode(client, pending.id, deps.keys.codeHash(pending.id, code)))) {
        return { kind: "resend_limit" };
      }
      return { kind: "resending", to: pending.email, code, existing: !pending.completable };
    }),
  );
  if (prepared.kind !== "resending") {
    return prepared;
  }
  const sent = await deliver(
    deps,
    caller,
    prepared.to,
    prepared.existing ? undefined : prepared.code,
  );
  return sent ? { kind: "resent" } : { kind: "email_unavailable" };
}

/** A signed-in person creates another organizer they own (the "already have an account" path). */
async function createAnother(
  deps: PasswordDeps,
  input: { name: string; accept: Acceptance },
  account: PublicAccount,
  caller: Caller,
): Promise<CreateResult> {
  const form = checkForm(input.name, input.accept);
  if (typeof form !== "string") {
    return form;
  }
  const userKey = deps.keys.userKey(account.id);
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { staffUserId: account.id }, async () => {
      if (!(await tryLock(client, userKey))) {
        return { kind: "throttled", retryAfterSeconds: 1 } as const;
      }
      const recent = await countRecent(
        client,
        BUCKETS.organizerCreate,
        userKey,
        L.organizersPerUser.windowSeconds,
      );
      if (recent.count >= L.organizersPerUser.max) {
        return { kind: "throttled", retryAfterSeconds: recent.retryAfterSeconds } as const;
      }
      await record(client, BUCKETS.organizerCreate, userKey);
      const organizerId = await withFreshSlug(
        client,
        () => slugFor(form),
        (slug) =>
          createOrganizer(client, {
            name: form,
            slug,
            accepted: input.accept,
            requestId: caller.requestId,
          }),
      );
      say(deps, caller, "staff.organizer_created", { user: account.id });
      return { kind: "created", organizerId } as const;
    }),
  );
}

/** Organizer sign-up (public) and creating another organizer while signed in (T-101, FR-1401, FR-1726). */
export function createSignUp(deps: PasswordDeps): SignUp {
  return {
    start: (input, caller) => start(deps, input, caller),
    code: (input, caller) => codeStep(deps, input, caller),
    resend: (input, caller) => resend(deps, input, caller),
    createOrganizer: (input, account, caller) => createAnother(deps, input, account, caller),
  };
}
