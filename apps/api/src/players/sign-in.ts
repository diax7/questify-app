import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  BAN_REASONS,
  checkUsername,
  missingSignupAcceptances,
  signupDocuments,
  toWesternDigits,
  type Avatar,
  type BanReason,
  type LegalInForce,
  type PlayerDocumentId,
  type SignupAcceptance,
  type UsernameCheck,
} from "@questify/shared";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { onlyRow } from "#src/db/rows";
import type { EmailSender } from "#src/auth/email/sender";
import { signInCodeEmail } from "#src/auth/email/templates";
import { generateCode, generateToken, hashToken, type AuthKeys } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS } from "#src/auth/limits";
import { isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import { reasonOf, say, type Caller } from "#src/auth/sign-in";
import { BUCKETS, countRecent, tryLock } from "#src/auth/throttle";
import { readInForce } from "#src/legal/in-force";
import { labelDevice, type DeviceLabel } from "#src/players/devices";
import { normalizeSaudiMobile } from "#src/players/phone";
import {
  failureCounts,
  firstFull,
  recordAll,
  recordVerified,
  sendCounts,
  withSendBudget,
  type Channel,
  type Count,
  type Throttled,
  type Unavailable,
} from "#src/players/sign-in-limits";
import type { SmsSender } from "#src/players/sms";

export type Lang = "ar" | "en";

export type PlayerSignInDeps = Readonly<{
  pool: Pool;
  keys: AuthKeys;
  sms: SmsSender;
  /** The staff path (Gmail, Resend backup), with its own daily budget for player codes (ADR-117). */
  email: EmailSender;
}>;

/** The sign-in's own deps: where a banned player appeals when no address is stored as configuration (MAIL_FROM, ADR-423). */
export type PlayerSignInFlowDeps = PlayerSignInDeps & Readonly<{ appealEmail: string }>;

/** Who is asking: the caller, plus the app's install id when it sent a well-formed one. */
export type Asker = Caller & Readonly<{ deviceId: string | undefined }>;

export type Issued = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  player: Readonly<{ id: string; username: string; avatar: Avatar }>;
}>;

export type CodeRequestResult =
  | Readonly<{
      kind: "code_sent";
      challengeToken: string;
      expiresInSeconds: number;
      resendAfterSeconds: number;
      emailFallbackAfterSeconds?: number;
    }>
  | Readonly<{ kind: "phone_not_supported" | "invalid_email" }>
  | Readonly<{ kind: "acceptance_required"; documents: readonly DocumentVersion[] }>
  | Throttled
  | Unavailable;

export type ResendResult =
  | Readonly<{ kind: "resent"; expiresInSeconds: number; resendAfterSeconds: number }>
  | Readonly<{ kind: "challenge_expired" | "resend_limit" }>
  | Readonly<{ kind: "resend_too_soon"; retryAfterSeconds: number }>
  | Throttled
  | Unavailable;

export type VerifyResult =
  | Readonly<{ kind: "signed_in"; issued: Issued }>
  | Readonly<{ kind: "new"; signupToken: string }>
  | Readonly<{ kind: "invalid_code"; attemptsLeft: number }>
  | Readonly<{ kind: "challenge_expired" }>
  | Readonly<{ kind: "account_banned"; notice: BanNotice }>
  | Throttled;

/**
 * What a banned player is shown after the right code (FR-1417, FR-1606): the ban's reason code (null for a ban with
 * none on record, such as a contact kept off after an erasure) and where to appeal.
 */
export type BanNotice = Readonly<{ reason: BanReason | null; appealEmail: string }>;

export type SignupResult =
  | Readonly<{ kind: "created"; issued: Issued }>
  | Readonly<{ kind: "invalid_username"; reason: string }>
  | Readonly<{
      kind:
        | "signup_expired"
        | "invalid_birth_year"
        | "too_young"
        | "username_taken"
        | "username_blocked"
        | "contact_taken";
    }>;

export type RefreshResult =
  | Readonly<{ kind: "rotated"; issued: Issued }>
  | Readonly<{ kind: "invalid" }>;

export type PlayerSignIn = Readonly<{
  requestCode: (
    input: {
      channel: Channel;
      value: string;
      previous?: string | undefined;
      lang: Lang;
      accept: SignupAcceptance;
    },
    asker: Asker,
  ) => Promise<CodeRequestResult>;
  resend: (input: { challengeToken: string; lang: Lang }, asker: Asker) => Promise<ResendResult>;
  verify: (
    input: { challengeToken: string; code: string; device?: DeviceLabel | undefined },
    asker: Asker,
  ) => Promise<VerifyResult>;
  signup: (
    input: {
      signupToken: string;
      username: string;
      birthYear: number;
      avatar: Avatar;
      device?: DeviceLabel | undefined;
    },
    asker: Asker,
  ) => Promise<SignupResult>;
  refresh: (input: { refreshToken: string }, asker: Asker) => Promise<RefreshResult>;
  logout: (input: { refreshToken: string }) => Promise<void>;
}>;

const L = PLAYER_SIGN_IN_LIMITS;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** The SHA-256 of a token as the database stores it (bytes). */
const tokenHash = (token: string): Buffer => Buffer.from(hashToken(token), "hex");

type Contact = Readonly<{ channel: Channel; value: string }>;

export type DocumentVersion = Readonly<{ id: PlayerDocumentId; version: string }>;

/** The terms and privacy in force, as a refusal names them so a stale app can show them and retry. */
function signupDocumentsInForce(inForce: LegalInForce): DocumentVersion[] {
  return signupDocuments(inForce).map(({ id, version }) => ({ id, version }));
}

/** The phone or email as the database stores it, or why it cannot take a code. */
export function contactOf(
  channel: Channel,
  typed: string,
): Contact | Readonly<{ kind: "phone_not_supported" | "invalid_email" }> {
  if (channel === "phone") {
    const phone = normalizeSaudiMobile(typed);
    return phone === undefined ? { kind: "phone_not_supported" } : { channel, value: phone };
  }
  const email = normalizeEmail(typed);
  return isPlausibleEmail(email) ? { channel, value: email } : { kind: "invalid_email" };
}

/** The sign-in SMS (one segment each; the text says what the code is for, CST 4.6.2; the Arabic brand name, ADR-019). */
export function smsText(code: string, lang: Lang): string {
  return lang === "ar"
    ? `رمز الدخول إلى كويستفاي: ${code}. لا تشاركه مع أحد.`
    : `Your Questify sign-in code is ${code}. Do not share it.`;
}

/** A typed code with Arabic-Indic and Persian digits made Western (ADR-018) and spaces trimmed. */
export function typedCode(typed: string): string {
  return toWesternDigits(typed).trim();
}

/**
 * The one row a function of migration 0013 always returns.
 *
 * @throws Error when it returned none, which would mean the function changed under the API.
 */
const inTransaction = <T>(deps: PlayerSignInDeps, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) => withRequestContext(client, {}, () => work(client)));

async function cancelChallenge(deps: PlayerSignInDeps, challengeToken: string): Promise<void> {
  await inTransaction(deps, (client) =>
    client.query("SELECT cancel_player_challenge($1)", [tokenHash(challengeToken)]),
  );
}

/**
 * The send windows read without a lock, before the platform budget is touched: a flood of throttled requests never
 * takes or holds a unit (ADR-690). The same windows are read again under the contact's lock in the transaction.
 */
export async function windowsRefuse(
  deps: PlayerSignInDeps,
  client: PoolClient,
  counts: readonly Count[],
  asker: Asker,
  where: Readonly<{ step: string; channel: Channel }>,
): Promise<Throttled | undefined> {
  const full = await firstFull(client, counts);
  if (full !== undefined) {
    say(deps, asker, "player.throttled", where);
  }
  return full;
}

/**
 * Holds one send against the contact, install and address windows under a lock on the contact, inside the caller's
 * transaction. Undefined means the send may go and is counted. The platform budget is held apart (`withSendBudget`).
 */
export async function holdWindows(
  deps: PlayerSignInDeps,
  client: PoolClient,
  counts: readonly Count[],
  asker: Asker,
  where: Readonly<{ step: string; channel: Channel; contact: string }>,
): Promise<Throttled | undefined> {
  if (!(await tryLock(client, deps.keys.contactThrottleKey(where.contact)))) {
    return { kind: "throttled", retryAfterSeconds: 1 };
  }
  const full = await windowsRefuse(deps, client, counts, asker, {
    step: where.step,
    channel: where.channel,
  });
  if (full !== undefined) {
    return full;
  }
  await recordAll(client, counts);
  return undefined;
}

/**
 * Sends the code. A message that may still arrive (a Msegat timeout) counts as sent: the app offers email after 30
 * seconds (M7). A definite refusal ends the challenge, so the person starts over or switches to email.
 */
async function deliver(
  deps: PlayerSignInDeps,
  asker: Asker,
  send: Readonly<{ contact: Contact; code: string; lang: Lang; challengeToken: string }>,
): Promise<"sent" | Unavailable["kind"]> {
  const { contact, code } = send;
  if (contact.channel === "phone") {
    const result = await deps.sms.send({ to: contact.value, text: smsText(code, send.lang) });
    if (result.kind !== "refused") {
      say(deps, asker, "player.code_sent", {
        channel: "phone",
        outcome: result.kind === "sent" ? "sent" : `unknown_${result.reason}`,
      });
      return "sent";
    }
    say(deps, asker, "player.sms_refused", { gateway: deps.sms.name, reason: result.reason });
    await cancelChallenge(deps, send.challengeToken);
    return "sms_unavailable";
  }
  try {
    await deps.email.send({
      to: contact.value,
      ...signInCodeEmail({ code, expiresInMinutes: L.codeLifetimeSeconds / 60 }),
    });
    say(deps, asker, "player.code_sent", { channel: "email", outcome: "sent" });
    return "sent";
  } catch (error) {
    say(deps, asker, "player.email_unavailable", { reason: reasonOf(error) });
    await cancelChallenge(deps, send.challengeToken);
    return "email_unavailable";
  }
}

/** `reviewer`: the App Review phone while its window is open (T-710, ADR-561): nothing is sent for it. */
type Opened = Readonly<{ kind: "opened"; challengeToken: string; code: string; reviewer: boolean }>;

async function startChallenge(
  deps: PlayerSignInDeps,
  client: PoolClient,
  contact: Contact,
  accept: SignupAcceptance,
  counts: readonly Count[],
  asker: Asker,
): Promise<Opened | Throttled> {
  const where = { step: "code", channel: contact.channel, contact: contact.value };
  const refused = await holdWindows(deps, client, counts, asker, where);
  if (refused !== undefined) {
    return refused;
  }
  const id = randomUUID();
  const token = generateToken();
  const code = generateCode();
  const { rows } = await client.query<{ reviewer: boolean }>(
    "SELECT start_player_challenge($1, $2, $3, $4, $5, $6, $7, $8, $9) AS reviewer",
    [
      id,
      tokenHash(token.token),
      contact.channel,
      contact.value,
      deps.keys.contactLookupKey(contact.value),
      deps.keys.playerCodeHash(id, code),
      accept.terms,
      accept.privacy,
      deps.keys.deletionFingerprint(contact.value),
    ],
  );
  const reviewer = onlyRow(rows, "start_player_challenge").reviewer;
  return { kind: "opened", challengeToken: token.token, code, reviewer } as const;
}

/**
 * The windows without a lock, then one unit of the platform budget in its own statement, then the challenge in the
 * request's transaction. The unit is given back unless a code goes out (the App Review phone gets none).
 */
async function openChallenge(
  deps: PlayerSignInDeps,
  contact: Contact,
  accept: SignupAcceptance,
  asker: Asker,
): Promise<Opened | Throttled | Unavailable> {
  const counts = sendCounts(deps.keys, contact, asker.address, asker.deviceId);
  return withConnection(deps.pool, async (client) => {
    const where = { step: "code", channel: contact.channel };
    const early = await windowsRefuse(deps, client, counts, asker, where);
    if (early !== undefined) {
      return early;
    }
    return withSendBudget(
      { deps, asker, client, channel: contact.channel },
      () =>
        withRequestContext(client, {}, () =>
          startChallenge(deps, client, contact, accept, counts, asker),
        ),
      (opened) => opened.kind === "opened" && !opened.reviewer,
    );
  });
}

type SweepClock = { last: number };

/** Removes old challenges and ended tokens at most every ten minutes. Best effort: a failure is logged only. */
async function sweepIfDue(deps: PlayerSignInDeps, asker: Asker, clock: SweepClock): Promise<void> {
  // Stryker disable next-line EqualityOperator: equivalent: a millisecond boundary on the wall clock
  if (Date.now() - clock.last < SWEEP_INTERVAL_MS) {
    return;
  }
  clock.last = Date.now();
  try {
    await inTransaction(deps, (client) => client.query("SELECT sweep_player_sign_in()"));
  } catch (error) {
    say(deps, asker, "player.sweep_failed", { reason: reasonOf(error) });
  }
}

async function requestCode(
  deps: PlayerSignInDeps,
  clock: SweepClock,
  input: Parameters<PlayerSignIn["requestCode"]>[0],
  asker: Asker,
): Promise<CodeRequestResult> {
  // First of all: nothing is counted, stored or logged for a person who has not accepted the versions in force
  // (FR-1705).
  const inForce = await readInForce(deps.pool);
  if (missingSignupAcceptances(inForce, input.accept).length > 0) {
    return { kind: "acceptance_required", documents: signupDocumentsInForce(inForce) };
  }
  const contact = contactOf(input.channel, input.value);
  if ("kind" in contact) {
    return contact;
  }
  const opened = await openChallenge(deps, contact, input.accept, asker);
  if (opened.kind !== "opened") {
    return opened;
  }
  await sweepIfDue(deps, asker, clock);
  if (opened.reviewer) {
    say(deps, asker, "player.reviewer_challenge");
  } else {
    const sent = await deliver(deps, asker, { contact, ...opened, lang: input.lang });
    if (sent !== "sent") {
      return { kind: sent };
    }
  }
  if (input.previous !== undefined) {
    // Only once the new code went out: the email fallback ends the SMS code (FR-1812). An unknown or finished token
    // changes nothing; a failed email leaves the SMS code usable.
    await cancelChallenge(deps, input.previous);
  }
  return {
    kind: "code_sent",
    challengeToken: opened.challengeToken,
    expiresInSeconds: L.codeLifetimeSeconds,
    resendAfterSeconds: L.resendSpacingSeconds,
    ...(contact.channel === "phone"
      ? { emailFallbackAfterSeconds: L.emailFallbackAfterSeconds }
      : {}),
  };
}

type LiveChallenge = Readonly<{
  id: string;
  channel: Channel;
  contact: string;
  resends: number;
  seconds_since_sent: number;
  reviewer: boolean;
}>;

async function liveChallenge(client: PoolClient, hash: Buffer): Promise<LiveChallenge | undefined> {
  const { rows } = await client.query<LiveChallenge>(
    "SELECT * FROM player_challenge_to_resend($1)",
    [hash],
  );
  return rows[0];
}

type Resending =
  | Exclude<ResendResult, { kind: "resent" }>
  | Readonly<{ kind: "resending"; contact: Contact; code: string }>
  | Readonly<{ kind: "reviewer" }>;

/** Why a challenge cannot be resent now, or the challenge to resend. */
function resendRefusal(challenge: LiveChallenge | undefined): Resending | LiveChallenge {
  if (challenge === undefined) {
    return { kind: "challenge_expired" };
  }
  if (challenge.reviewer) {
    return { kind: "reviewer" };
  }
  if (challenge.resends >= L.maxResends) {
    return { kind: "resend_limit" };
  }
  // Stryker disable next-line EqualityOperator: equivalent: fractional seconds from the database clock are never exactly 60
  if (challenge.seconds_since_sent < L.resendSpacingSeconds) {
    return {
      kind: "resend_too_soon",
      retryAfterSeconds: Math.ceil(L.resendSpacingSeconds - challenge.seconds_since_sent),
    };
  }
  return challenge;
}

/** The resend in the request's transaction: the challenge read again, the windows under the contact's lock, the code. */
async function resendInTransaction(
  deps: PlayerSignInDeps,
  client: PoolClient,
  hash: Buffer,
  asker: Asker,
): Promise<Resending> {
  const challenge = resendRefusal(await liveChallenge(client, hash));
  if ("kind" in challenge) {
    return challenge;
  }
  const contact = { channel: challenge.channel, value: challenge.contact };
  const counts = sendCounts(deps.keys, contact, asker.address, asker.deviceId);
  const where = { step: "code", channel: contact.channel, contact: contact.value };
  const refused = await holdWindows(deps, client, counts, asker, where);
  if (refused !== undefined) {
    return refused;
  }
  const code = generateCode();
  const { rows } = await client.query<{ ok: boolean }>(
    "SELECT resend_player_challenge($1, $2) AS ok",
    [hash, deps.keys.playerCodeHash(challenge.id, code)],
  );
  // Stryker disable next-line ConditionalExpression: defence in depth: the checks above already refused what the function refuses
  return onlyRow(rows, "resend_player_challenge").ok
    ? { kind: "resending", contact, code }
    : // Stryker disable next-line ObjectLiteral,StringLiteral: defence in depth: the checks above already refused what the function refuses
      { kind: "resend_limit" };
}

/**
 * The challenge and the windows are read first without a lock, so a refused resend never touches the platform budget;
 * then one unit is held for the channel and the resend runs in its own transaction, given back unless a code goes.
 */
async function prepareResend(
  deps: PlayerSignInDeps,
  hash: Buffer,
  asker: Asker,
): Promise<Resending> {
  return withConnection(deps.pool, async (client): Promise<Resending> => {
    const first = resendRefusal(
      await withRequestContext(client, {}, () => liveChallenge(client, hash)),
    );
    if ("kind" in first) {
      return first;
    }
    const contact = { channel: first.channel, value: first.contact };
    const counts = sendCounts(deps.keys, contact, asker.address, asker.deviceId);
    const early = await windowsRefuse(deps, client, counts, asker, {
      step: "code",
      channel: contact.channel,
    });
    if (early !== undefined) {
      return early;
    }
    return withSendBudget(
      { deps, asker, client, channel: contact.channel },
      () => withRequestContext(client, {}, () => resendInTransaction(deps, client, hash, asker)),
      (prepared) => prepared.kind === "resending",
    );
  });
}

async function resend(
  deps: PlayerSignInDeps,
  input: Parameters<PlayerSignIn["resend"]>[0],
  asker: Asker,
): Promise<ResendResult> {
  const prepared = await prepareResend(deps, tokenHash(input.challengeToken), asker);
  if (prepared.kind === "reviewer") {
    // The App Review challenge is answered by the fixed code; nothing is ever sent for it (ADR-561).
    return {
      kind: "resent",
      expiresInSeconds: L.codeLifetimeSeconds,
      resendAfterSeconds: L.resendSpacingSeconds,
    };
  }
  if (prepared.kind !== "resending") {
    return prepared;
  }
  const sent = await deliver(deps, asker, {
    contact: prepared.contact,
    code: prepared.code,
    lang: input.lang,
    challengeToken: input.challengeToken,
  });
  return sent === "sent"
    ? {
        kind: "resent",
        expiresInSeconds: L.codeLifetimeSeconds,
        resendAfterSeconds: L.resendSpacingSeconds,
      }
    : { kind: sent };
}

/** A fresh access and refresh pair in a new or the same family; the database stores only their hashes. */
function newTokens() {
  const access = generateToken().token;
  const refreshToken = generateToken().token;
  return {
    access,
    refresh: refreshToken,
    accessHash: tokenHash(access),
    refreshHash: tokenHash(refreshToken),
    family: randomUUID(),
  };
}
type NewTokens = ReturnType<typeof newTokens>;

/** The answer for issued tokens, with the player's name read as the player. */
async function issuedTo(
  deps: PlayerSignInDeps,
  playerId: string,
  tokens: NewTokens,
): Promise<Issued> {
  const { rows } = await withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, () =>
      client.query<{ username: string; avatar: Avatar }>(
        "SELECT username, avatar FROM player WHERE id = $1",
        [playerId],
      ),
    ),
  );
  // The tokens were just issued to this player in a committed transaction, so its row is readable.
  const { username, avatar } = onlyRow(rows, "the player's own row");
  return {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresInSeconds: L.accessTokenSeconds,
    player: { id: playerId, username, avatar },
  };
}

type Judged =
  | Exclude<VerifyResult, { kind: "signed_in" | "account_banned" }>
  | Readonly<{ kind: "signed_in"; playerId: string }>
  | Readonly<{ kind: "account_banned"; playerId: string }>;

const VERDICTS: Readonly<
  Record<string, (left: number, id: string, signupToken: string) => Judged>
> = {
  expired: () => ({ kind: "challenge_expired" }),
  wrong: (left) => ({ kind: "invalid_code", attemptsLeft: left }),
  banned: (_left, id) => ({ kind: "account_banned", playerId: id }),
  signed_in: (_left, id) => ({ kind: "signed_in", playerId: id }),
  new: (_left, _id, signupToken) => ({ kind: "new", signupToken }),
};

/**
 * Counts what a typed code did, in the judging transaction: a right one earns its address room (ADR-691), a wrong one
 * counts in the failure windows (and warns when the App Review phone is being guessed).
 */
async function countOutcome(
  deps: PlayerSignInDeps,
  client: PoolClient,
  judged: Readonly<{ outcome: string; challenge: LiveChallenge; counts: readonly Count[] }>,
  asker: Asker,
): Promise<void> {
  const { outcome, challenge, counts } = judged;
  if (outcome === "signed_in" || outcome === "new") {
    const contact = { channel: challenge.channel, value: challenge.contact };
    await recordVerified(client, deps.keys, contact, asker.address);
  }
  if (outcome === "wrong") {
    await recordAll(client, counts);
    if (challenge.reviewer) {
      await warnGuessing(deps, client, challenge.contact, asker);
    }
  }
}

/** Checks the code under a lock on the contact, inside the failure windows; only a wrong code is counted. */
async function judge(
  deps: PlayerSignInDeps,
  input: Parameters<PlayerSignIn["verify"]>[0],
  tokens: NewTokens,
  asker: Asker,
): Promise<Judged> {
  const hash = tokenHash(input.challengeToken);
  return inTransaction(deps, async (client): Promise<Judged> => {
    const challenge = await liveChallenge(client, hash);
    if (challenge === undefined) {
      return { kind: "challenge_expired" };
    }
    const contact = { channel: challenge.channel, value: challenge.contact };
    const counts = failureCounts(deps.keys, contact, asker.address);
    if (!(await tryLock(client, deps.keys.contactThrottleKey(challenge.contact)))) {
      return { kind: "throttled", retryAfterSeconds: 1 };
    }
    const full = await firstFull(client, counts);
    if (full !== undefined) {
      return full;
    }
    const signupToken = generateToken().token;
    const { rows } = await client.query<{
      outcome: string;
      attempts_left: number;
      player_id: string | null;
    }>("SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6, $7)", [
      hash,
      deps.keys.playerCodeHash(challenge.id, typedCode(input.code)),
      tokens.accessHash,
      tokens.refreshHash,
      tokens.family,
      tokenHash(signupToken),
      deps.keys.reviewerCodeHash(typedCode(input.code)),
    ]);
    const row = onlyRow(rows, "sign_in_player");
    await countOutcome(deps, client, { outcome: row.outcome, challenge, counts }, asker);
    const verdict = VERDICTS[row.outcome];
    // Stryker disable next-line ConditionalExpression,ObjectLiteral,StringLiteral: unreachable: sign_in_player has only these five outcomes
    return verdict === undefined
      ? { kind: "challenge_expired" }
      : verdict(row.attempts_left, row.player_id ?? "", signupToken);
  });
}

/** Wrong reviewer codes past this many in a contact's day window log one warning (ADR-561). */
const GUESSING_WARN_AFTER = 10;

/**
 * Logs `review_demo.code_guessing` (no contact) once, when the reviewer phone's wrong codes in its day window pass
 * GUESSING_WARN_AFTER: the admin may close the window or prepare a new code (RUNBOOK).
 */
async function warnGuessing(
  deps: PlayerSignInDeps,
  client: PoolClient,
  contact: string,
  asker: Asker,
): Promise<void> {
  const day = L.failuresPerContactDay;
  const { count } = await countRecent(
    client,
    BUCKETS.playerFailContact,
    deps.keys.contactThrottleKey(contact),
    day.windowSeconds,
  );
  if (count === GUESSING_WARN_AFTER + 1) {
    say(deps, asker, "review_demo.code_guessing", { wrongToday: count });
  }
}

const isBanReason = (code: string | null): code is BanReason =>
  code !== null && (BAN_REASONS as readonly string[]).includes(code);

/** The banned account's notice (ban_notice, migration 0120); an empty id is a contact kept off after an erasure. */
async function banNotice(deps: PlayerSignInFlowDeps, playerId: string): Promise<BanNotice> {
  if (playerId === "") {
    return { reason: null, appealEmail: deps.appealEmail };
  }
  const { rows } = await inTransaction(deps, (client) =>
    client.query<{ reason: string | null; appeal_email: string | null }>(
      "SELECT reason, appeal_email FROM ban_notice($1)",
      [playerId],
    ),
  );
  const row = rows[0];
  return {
    reason: isBanReason(row?.reason ?? null) ? (row?.reason as BanReason) : null,
    appealEmail: row?.appeal_email ?? deps.appealEmail,
  };
}

async function verify(
  deps: PlayerSignInFlowDeps,
  clock: SweepClock,
  input: Parameters<PlayerSignIn["verify"]>[0],
  asker: Asker,
): Promise<VerifyResult> {
  const tokens = newTokens();
  const judged = await judge(deps, input, tokens, asker);
  await sweepIfDue(deps, asker, clock);
  if (judged.kind === "account_banned") {
    return { kind: "account_banned", notice: await banNotice(deps, judged.playerId) };
  }
  if (judged.kind !== "signed_in") {
    if (judged.kind === "invalid_code" || judged.kind === "throttled") {
      say(deps, asker, judged.kind === "throttled" ? "player.throttled" : "player.code_failed", {
        step: "verify",
      });
    }
    return judged;
  }
  say(deps, asker, "player.signed_in", { player: judged.playerId });
  await labelDevice(deps, tokens.refreshHash, input.device, asker);
  return { kind: "signed_in", issued: await issuedTo(deps, judged.playerId, tokens) };
}

type SignupRefusal = Exclude<SignupResult, { kind: "created" | "invalid_username" }>["kind"];

const SIGNUP_OUTCOMES: Readonly<Record<string, SignupRefusal>> = {
  expired: "signup_expired",
  invalid_birth_year: "invalid_birth_year",
  too_young: "too_young",
  username_taken: "username_taken",
  username_blocked: "username_blocked",
  contact_taken: "contact_taken",
};

async function signup(
  deps: PlayerSignInDeps,
  input: Parameters<PlayerSignIn["signup"]>[0],
  asker: Asker,
): Promise<SignupResult> {
  const name: UsernameCheck = checkUsername(input.username);
  if (!name.ok) {
    return { kind: "invalid_username", reason: name.reason };
  }
  const tokens = newTokens();
  const { rows } = await inTransaction(deps, (client) =>
    client.query<{ outcome: string; player_id: string | null }>(
      "SELECT * FROM create_player($1, $2, $3, $4, $5, $6, $7)",
      [
        tokenHash(input.signupToken),
        name.username,
        input.birthYear,
        input.avatar,
        tokens.accessHash,
        tokens.refreshHash,
        tokens.family,
      ],
    ),
  );
  const row = onlyRow(rows, "create_player");
  // Stryker disable next-line ConditionalExpression,LogicalOperator: defence in depth: a created player always has an id
  if (row.outcome !== "created" || row.player_id === null) {
    // Stryker disable next-line StringLiteral: unreachable: create_player has only these outcomes
    return { kind: SIGNUP_OUTCOMES[row.outcome] ?? "signup_expired" };
  }
  say(deps, asker, "player.signed_up", { player: row.player_id });
  await labelDevice(deps, tokens.refreshHash, input.device, asker);
  return { kind: "created", issued: await issuedTo(deps, row.player_id, tokens) };
}

async function refresh(
  deps: PlayerSignInDeps,
  input: Parameters<PlayerSignIn["refresh"]>[0],
  asker: Asker,
): Promise<RefreshResult> {
  const tokens = newTokens();
  const { rows } = await inTransaction(deps, (client) =>
    client.query<{ outcome: string; player_id: string | null }>(
      "SELECT * FROM rotate_player_refresh($1, $2, $3)",
      [tokenHash(input.refreshToken), tokens.accessHash, tokens.refreshHash],
    ),
  );
  const row = onlyRow(rows, "rotate_player_refresh");
  // Stryker disable next-line ConditionalExpression,LogicalOperator: defence in depth: a rotated pair always has its player
  if (row.outcome !== "rotated" || row.player_id === null) {
    if (row.outcome === "reused") {
      say(deps, asker, "player.refresh_reuse");
    }
    return { kind: "invalid" };
  }
  return { kind: "rotated", issued: await issuedTo(deps, row.player_id, tokens) };
}

/**
 * Player sign-in (T-107): a code by SMS or email, an account from the profile step, and sessions (a 1-hour access token
 * and a rotating 180-day refresh token). Every rule that guards a session lives in the database functions (migration
 * 0013); this module counts, sends and answers.
 */
export function createPlayerSignIn(deps: PlayerSignInFlowDeps): PlayerSignIn {
  // Stryker disable next-line ObjectLiteral: equivalent: an undefined start makes the first comparison NaN, which also means 'sweep now'
  const clock: SweepClock = { last: 0 };
  return {
    requestCode: (input, asker) => requestCode(deps, clock, input, asker),
    resend: (input, asker) => resend(deps, input, asker),
    verify: (input, asker) => verify(deps, clock, input, asker),
    signup: (input, asker) => signup(deps, input, asker),
    refresh: (input, asker) => refresh(deps, input, asker),
    logout: async (input) => {
      await inTransaction(deps, (client) =>
        client.query("SELECT sign_out_player($1)", [tokenHash(input.refreshToken)]),
      );
    },
  };
}
