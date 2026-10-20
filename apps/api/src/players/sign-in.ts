import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { checkUsername, toWesternDigits, type UsernameCheck } from "@questify/shared";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { EmailSender } from "#src/auth/email/sender";
import { signInCodeEmail } from "#src/auth/email/templates";
import { generateCode, generateToken, hashToken, type AuthKeys } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS } from "#src/auth/limits";
import { isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import { reasonOf, say, type Caller } from "#src/auth/sign-in";
import { tryLock } from "#src/auth/throttle";
import { normalizeSaudiMobile } from "#src/players/phone";
import {
  failureCounts,
  firstFull,
  recordAll,
  sendCounts,
  takePlatformBudget,
  type Channel,
  type Throttled,
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

/** Who is asking: the caller, plus the app's install id when it sent a well-formed one. */
export type Asker = Caller & Readonly<{ deviceId: string | undefined }>;

export type Issued = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  player: Readonly<{ id: string; username: string }>;
}>;

type Unavailable = Readonly<{ kind: "sms_unavailable" | "email_unavailable" }>;

export type CodeRequestResult =
  | Readonly<{
      kind: "code_sent";
      challengeToken: string;
      expiresInSeconds: number;
      resendAfterSeconds: number;
      emailFallbackAfterSeconds?: number;
    }>
  | Readonly<{ kind: "phone_not_supported" | "invalid_email" }>
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
  | Readonly<{ kind: "challenge_expired" | "account_banned" }>
  | Throttled;

export type SignupResult =
  | Readonly<{ kind: "created"; issued: Issued }>
  | Readonly<{ kind: "invalid_username"; reason: string }>
  | Readonly<{
      kind:
        | "signup_expired"
        | "invalid_birth_year"
        | "too_young"
        | "username_taken"
        | "contact_taken";
    }>;

export type RefreshResult =
  | Readonly<{ kind: "rotated"; issued: Issued }>
  | Readonly<{ kind: "invalid" }>;

export type PlayerSignIn = Readonly<{
  requestCode: (
    input: { channel: Channel; value: string; previous?: string | undefined; lang: Lang },
    asker: Asker,
  ) => Promise<CodeRequestResult>;
  resend: (input: { challengeToken: string; lang: Lang }, asker: Asker) => Promise<ResendResult>;
  verify: (input: { challengeToken: string; code: string }, asker: Asker) => Promise<VerifyResult>;
  signup: (
    input: { signupToken: string; username: string; birthYear: number },
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
function onlyRow<T>(rows: readonly T[], name: string): T {
  const [row] = rows;
  // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral: unreachable: these functions return exactly one row
  if (row === undefined) {
    throw new Error(`${name} returned no row.`);
  }
  return row;
}

const inTransaction = <T>(deps: PlayerSignInDeps, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) => withRequestContext(client, {}, () => work(client)));

async function cancelChallenge(deps: PlayerSignInDeps, challengeToken: string): Promise<void> {
  await inTransaction(deps, (client) =>
    client.query("SELECT cancel_player_challenge($1)", [tokenHash(challengeToken)]),
  );
}

/**
 * Holds one send against the contact, install and address windows and the platform budget, all under a lock on the
 * contact, inside the caller's transaction. Undefined means the send may go and is counted.
 */
async function takeSend(
  deps: PlayerSignInDeps,
  client: PoolClient,
  contact: Contact,
  asker: Asker,
): Promise<Throttled | Unavailable | undefined> {
  const counts = sendCounts(deps.keys, contact.value, asker.address, asker.deviceId);
  if (!(await tryLock(client, deps.keys.contactThrottleKey(contact.value)))) {
    return { kind: "throttled", retryAfterSeconds: 1 };
  }
  const full = await firstFull(client, counts);
  if (full !== undefined) {
    say(deps, asker, "player.throttled", { step: "code", channel: contact.channel });
    return full;
  }
  const budget = await takePlatformBudget(client, contact.channel);
  if (budget === "spent") {
    say(deps, asker, "player.budget_spent", { channel: contact.channel });
    return { kind: contact.channel === "phone" ? "sms_unavailable" : "email_unavailable" };
  }
  if (budget === "half") {
    say(deps, asker, "player.budget_half", { channel: contact.channel });
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

type Opened = Readonly<{ kind: "opened"; challengeToken: string; code: string }>;

async function openChallenge(
  deps: PlayerSignInDeps,
  contact: Contact,
  asker: Asker,
): Promise<Opened | Throttled | Unavailable> {
  return inTransaction(deps, async (client) => {
    const refused = await takeSend(deps, client, contact, asker);
    if (refused !== undefined) {
      return refused;
    }
    const id = randomUUID();
    const token = generateToken();
    const code = generateCode();
    await client.query("SELECT start_player_challenge($1, $2, $3, $4, $5, $6)", [
      id,
      tokenHash(token.token),
      contact.channel,
      contact.value,
      deps.keys.contactLookupKey(contact.value),
      deps.keys.playerCodeHash(id, code),
    ]);
    return { kind: "opened", challengeToken: token.token, code } as const;
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
  const contact = contactOf(input.channel, input.value);
  if ("kind" in contact) {
    return contact;
  }
  const opened = await openChallenge(deps, contact, asker);
  if (opened.kind !== "opened") {
    return opened;
  }
  await sweepIfDue(deps, asker, clock);
  const sent = await deliver(deps, asker, { contact, ...opened, lang: input.lang });
  if (sent !== "sent") {
    return { kind: sent };
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
  | Readonly<{ kind: "resending"; contact: Contact; code: string }>;

async function prepareResend(
  deps: PlayerSignInDeps,
  hash: Buffer,
  asker: Asker,
): Promise<Resending> {
  return inTransaction(deps, async (client): Promise<Resending> => {
    const challenge = await liveChallenge(client, hash);
    if (challenge === undefined) {
      return { kind: "challenge_expired" };
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
    const contact = { channel: challenge.channel, value: challenge.contact };
    const refused = await takeSend(deps, client, contact, asker);
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
  });
}

async function resend(
  deps: PlayerSignInDeps,
  input: Parameters<PlayerSignIn["resend"]>[0],
  asker: Asker,
): Promise<ResendResult> {
  const prepared = await prepareResend(deps, tokenHash(input.challengeToken), asker);
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
      client.query<{ username: string }>("SELECT username FROM player WHERE id = $1", [playerId]),
    ),
  );
  // The tokens were just issued to this player in a committed transaction, so its row is readable.
  const { username } = onlyRow(rows, "the player's own row");
  return {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresInSeconds: L.accessTokenSeconds,
    player: { id: playerId, username },
  };
}

type Judged =
  | Exclude<VerifyResult, { kind: "signed_in" }>
  | Readonly<{ kind: "signed_in"; playerId: string }>;

const VERDICTS: Readonly<
  Record<string, (left: number, id: string, signupToken: string) => Judged>
> = {
  expired: () => ({ kind: "challenge_expired" }),
  wrong: (left) => ({ kind: "invalid_code", attemptsLeft: left }),
  banned: () => ({ kind: "account_banned" }),
  signed_in: (_left, id) => ({ kind: "signed_in", playerId: id }),
  new: (_left, _id, signupToken) => ({ kind: "new", signupToken }),
};

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
    const counts = failureCounts(deps.keys, challenge.contact, asker.address);
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
    }>("SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6)", [
      hash,
      deps.keys.playerCodeHash(challenge.id, typedCode(input.code)),
      tokens.accessHash,
      tokens.refreshHash,
      tokens.family,
      tokenHash(signupToken),
    ]);
    const row = onlyRow(rows, "sign_in_player");
    if (row.outcome === "wrong") {
      await recordAll(client, counts);
    }
    const verdict = VERDICTS[row.outcome];
    // Stryker disable next-line ConditionalExpression,ObjectLiteral,StringLiteral: unreachable: sign_in_player has only these five outcomes
    return verdict === undefined
      ? { kind: "challenge_expired" }
      : verdict(row.attempts_left, row.player_id ?? "", signupToken);
  });
}

async function verify(
  deps: PlayerSignInDeps,
  clock: SweepClock,
  input: Parameters<PlayerSignIn["verify"]>[0],
  asker: Asker,
): Promise<VerifyResult> {
  const tokens = newTokens();
  const judged = await judge(deps, input, tokens, asker);
  await sweepIfDue(deps, asker, clock);
  if (judged.kind !== "signed_in") {
    if (judged.kind === "invalid_code" || judged.kind === "throttled") {
      say(deps, asker, judged.kind === "throttled" ? "player.throttled" : "player.code_failed", {
        step: "verify",
      });
    }
    return judged;
  }
  say(deps, asker, "player.signed_in", { player: judged.playerId });
  return { kind: "signed_in", issued: await issuedTo(deps, judged.playerId, tokens) };
}

type SignupRefusal = Exclude<SignupResult, { kind: "created" | "invalid_username" }>["kind"];

const SIGNUP_OUTCOMES: Readonly<Record<string, SignupRefusal>> = {
  expired: "signup_expired",
  invalid_birth_year: "invalid_birth_year",
  too_young: "too_young",
  username_taken: "username_taken",
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
      "SELECT * FROM create_player($1, $2, $3, $4, $5, $6)",
      [
        tokenHash(input.signupToken),
        name.username,
        input.birthYear,
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
export function createPlayerSignIn(deps: PlayerSignInDeps): PlayerSignIn {
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
