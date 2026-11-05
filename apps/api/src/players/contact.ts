import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { contactChangedEmail, contactCodeEmail } from "#src/auth/email/templates";
import {
  challengeExpired,
  contactCodeWrong,
  contactInUse,
  contactLocked,
  contactUnchanged,
  emailUnavailable,
  invalidRequest,
  phoneNotSupported,
  smsUnavailable,
  tooManyAttempts,
  unauthenticated,
} from "#src/auth/http-errors";
import { generateCode, generateToken, hashToken } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS } from "#src/auth/limits";
import { addressBucket } from "#src/auth/normalize";
import { reasonOf, say } from "#src/auth/sign-in";
import { BUCKETS, tryLock } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { onlyRow } from "#src/db/rows";
import type { HttpError } from "#src/http-error";
import { parse } from "#src/auth/request";
import { ownSession, registerSignedInDeviceRoutes } from "#src/players/devices";
import { readMe, type ProfileDeps } from "#src/players/profile";
import { askerOf } from "#src/players/routes";
import {
  contactOf,
  holdWindows,
  typedCode,
  windowsRefuse,
  type Asker,
  type Lang,
  type PlayerSignInDeps,
} from "#src/players/sign-in";
import {
  firstFull,
  recordAll,
  reserveSend,
  sendCounts,
  withSendBudget,
  type Channel,
  type Count,
  type Throttled,
  type Unavailable,
} from "#src/players/sign-in-limits";

const L = PLAYER_SIGN_IN_LIMITS;

export type ContactCodeResult =
  | Readonly<{ kind: "code_sent"; challengeToken: string; expiresInSeconds: number }>
  | Readonly<{ kind: "unchanged" | "locked" | "phone_not_supported" | "invalid_email" }>
  | Throttled
  | Unavailable;

export type ContactConfirmResult =
  | Readonly<{ kind: "changed" | "expired" | "taken" }>
  | Readonly<{ kind: "invalid_code"; attemptsLeft: number }>
  | Throttled;

/** The code SMS for a new number (one segment each; it says what the code is for, CST 4.6.2). */
export function contactSmsText(code: string, lang: Lang): string {
  return lang === "ar"
    ? `رمز إضافة هذا الرقم إلى حساب كويستفاي: ${code}. لا تشاركه.`
    : `Your code to add this number to a Questify account: ${code}. Do not share it.`;
}

/** The notice SMS to an old or other number: it never names the new value. */
export function contactNoticeSmsText(lang: Lang): string {
  return lang === "ar"
    ? "تغيّرت بيانات دخولك في كويستفاي. إن لم تكن أنت، تواصل معنا من التطبيق."
    : "Your Questify sign-in details changed. If this was not you, contact us in the app.";
}

const tokenHash = (token: string): Buffer => Buffer.from(hashToken(token), "hex");

/** A code's hash, bound to its own challenge by the token's hash (the API holds the token, never the row's id). */
const codeHash = (deps: PlayerSignInDeps, token: string, code: string): Buffer =>
  deps.keys.playerCodeHash(hashToken(token), code);

const asPlayer = <T>(
  deps: PlayerSignInDeps,
  playerId: string,
  work: (client: PoolClient) => Promise<T>,
) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, () => work(client)),
  );

const inTransaction = <T>(deps: PlayerSignInDeps, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) => withRequestContext(client, {}, () => work(client)));

function playerCounts(deps: PlayerSignInDeps, playerId: string): Count[] {
  const key = deps.keys.playerKey(playerId);
  return [
    { bucket: BUCKETS.contactCodePlayer, key, limit: L.contactCodesPerPlayerHour },
    { bucket: BUCKETS.contactCodePlayer, key, limit: L.contactCodesPerPlayerDay },
  ];
}

function failureCountsOf(deps: PlayerSignInDeps, playerId: string, address: string): Count[] {
  const key = deps.keys.playerKey(playerId);
  return [
    { bucket: BUCKETS.contactFailPlayer, key, limit: L.contactFailuresPerPlayer },
    { bucket: BUCKETS.contactFailPlayer, key, limit: L.contactFailuresPerPlayerDay },
    {
      bucket: BUCKETS.playerFailAddress,
      key: deps.keys.addressKey(addressBucket(address)),
      limit: L.failuresPerAddress,
    },
  ];
}

/**
 * Counts this request in the player's window before anything else, in its own transaction, so every request counts:
 * one refused as unchanged too (no probing without limit, T-108 Revision 1).
 */
async function takePlayerWindow(
  deps: PlayerSignInDeps,
  playerId: string,
): Promise<Throttled | undefined> {
  return inTransaction(deps, async (client) => {
    // Stryker disable next-line ConditionalExpression,BlockStatement,ObjectLiteral: lock contention between two requests of one player: timing, not a path a test can hold
    if (!(await tryLock(client, deps.keys.playerKey(playerId)))) {
      return { kind: "throttled", retryAfterSeconds: 1 } as const;
    }
    const counts = playerCounts(deps, playerId);
    const full = await firstFull(client, counts);
    if (full !== undefined) {
      return full;
    }
    await recordAll(client, counts);
    return undefined;
  });
}

type Contact = Readonly<{ channel: Channel; value: string }>;

type Opened = Readonly<{ kind: "opened"; token: string; code: string }>;

/** The challenge in the player's transaction: the windows under the contact's lock, then the new challenge. */
async function startChange(
  deps: PlayerSignInDeps,
  client: PoolClient,
  contact: Contact,
  counts: readonly Count[],
  asker: Asker,
): Promise<Opened | Readonly<{ kind: "unchanged" | "locked" }> | Throttled> {
  const where = { step: "contact_code", channel: contact.channel, contact: contact.value };
  const refused = await holdWindows(deps, client, counts, asker, where);
  if (refused !== undefined) {
    return refused;
  }
  const id = randomUUID();
  const token = generateToken().token;
  const code = generateCode();
  const { rows } = await client.query<{ outcome: "started" | "unchanged" | "locked" }>(
    "SELECT start_contact_change($1, $2, $3, $4, $5, $6) AS outcome",
    [
      id,
      tokenHash(token),
      contact.channel,
      contact.value,
      codeHash(deps, token, code),
      deps.keys.deletionFingerprint(contact.value),
    ],
  );
  // Stryker disable next-line StringLiteral: the name only labels an impossible error
  const outcome = onlyRow(rows, "start_contact_change").outcome;
  if (outcome !== "started") {
    // An unchanged contact, or an App Review demo account, whose number never changes (T-710, Q-523). Throwing rolls
    // the windows back: nothing is sent, so nothing is counted.
    throw new NotStarted(outcome);
  }
  return { kind: "opened", token, code } as const;
}

class NotStarted extends Error {
  constructor(readonly outcome: "unchanged" | "locked") {
    // Stryker disable next-line StringLiteral: never shown: the error is caught in openChange
    super("the contact change did not start");
  }
}

/**
 * Opens the challenge for the new contact against the same send windows and platform budget as sign-in: the windows
 * without a lock first, then one unit of the budget, then the challenge; the unit is given back unless it opened.
 */
async function openChange(
  deps: PlayerSignInDeps,
  playerId: string,
  contact: Contact,
  asker: Asker,
): Promise<Opened | Readonly<{ kind: "unchanged" | "locked" }> | Throttled | Unavailable> {
  const counts = sendCounts(deps.keys, contact, asker.address, asker.deviceId);
  return withConnection(deps.pool, async (client) => {
    const where = { step: "contact_code", channel: contact.channel };
    const early = await windowsRefuse(deps, client, counts, asker, where);
    if (early !== undefined) {
      return early;
    }
    return withSendBudget(
      { deps, asker, client, channel: contact.channel },
      () =>
        withRequestContext(client, { playerId }, () =>
          startChange(deps, client, contact, counts, asker),
        ).catch((error: unknown) => {
          // Stryker disable next-line ConditionalExpression: only a database failure reaches the rethrow below
          if (error instanceof NotStarted) {
            return { kind: error.outcome } as const;
          }
          throw error;
        }),
      (opened) => opened.kind === "opened",
    );
  });
}

async function sendCode(
  deps: PlayerSignInDeps,
  asker: Asker,
  send: Readonly<{ contact: Contact; code: string; lang: Lang }>,
): Promise<"sent" | Unavailable["kind"]> {
  if (send.contact.channel === "phone") {
    const result = await deps.sms.send({
      to: send.contact.value,
      text: contactSmsText(send.code, send.lang),
    });
    if (result.kind === "refused") {
      say(deps, asker, "player.sms_refused", { gateway: deps.sms.name, reason: result.reason });
      // Unlike sign-in, the challenge is left to expire: the player's next request replaces it (one row a player).
      return "sms_unavailable";
    }
    say(deps, asker, "player.contact_code_sent", { channel: "phone" });
    return "sent";
  }
  try {
    await deps.email.send({
      to: send.contact.value,
      ...contactCodeEmail({ code: send.code, expiresInMinutes: L.codeLifetimeSeconds / 60 }),
    });
    say(deps, asker, "player.contact_code_sent", { channel: "email" });
    return "sent";
  } catch (error) {
    say(deps, asker, "player.email_unavailable", { reason: reasonOf(error) });
    return "email_unavailable";
  }
}

/**
 * Sends a code to a new phone or email for the signed-in player (FR-125, FR-139). Whether another account has it is
 * not said here: only the right code shows that, at confirm.
 */
export async function requestContactCode(
  deps: PlayerSignInDeps,
  input: Readonly<{ playerId: string; channel: Channel; value: string; lang: Lang }>,
  asker: Asker,
): Promise<ContactCodeResult> {
  const throttled = await takePlayerWindow(deps, input.playerId);
  if (throttled !== undefined) {
    say(deps, asker, "player.throttled", { step: "contact_window" });
    return throttled;
  }
  const contact = contactOf(input.channel, input.value);
  if ("kind" in contact) {
    return contact;
  }
  const opened = await openChange(deps, input.playerId, contact, asker);
  if (opened.kind !== "opened") {
    return opened;
  }
  const sent = await sendCode(deps, asker, { contact, code: opened.code, lang: input.lang });
  if (sent !== "sent") {
    return { kind: sent };
  }
  return {
    kind: "code_sent",
    challengeToken: opened.token,
    expiresInSeconds: L.codeLifetimeSeconds,
  };
}

/** A row of `confirm_contact_change` (migrations 0144, 0155): only a changed one carries its channel, kind and old values. */
type Confirmed =
  | Readonly<{ outcome: "wrong"; attempts_left: number }>
  | Readonly<{ outcome: "expired" | "taken" }>
  | Readonly<{
      outcome: "changed";
      channel: Channel;
      kind: "added" | "replaced";
      previous: string | null;
      other: string | null;
    }>;

/** One notice, best effort: it takes from the platform budget, and a failure or a spent budget is only logged. */
async function notify(
  deps: PlayerSignInDeps,
  asker: Asker,
  to: string,
  change: Readonly<{ channel: Channel; kind: "added" | "replaced"; lang: Lang }>,
): Promise<void> {
  const channel: Channel = to.startsWith("+") ? "phone" : "email";
  try {
    // A notice always goes once it holds a unit, so the unit is never given back.
    const budget = await withConnection(deps.pool, (client) => reserveSend(client, channel));
    if (budget.kind !== "held") {
      say(deps, asker, "player.notice_skipped", { channel, budget: budget.kind });
      return;
    }
    if (channel === "email") {
      await deps.email.send({ to, ...contactChangedEmail(change) });
      say(deps, asker, "player.notice_sent", { channel });
      return;
    }
    // The SMS sender answers rather than throws: a refusal is a failure to see, an unknown outcome may still arrive.
    const result = await deps.sms.send({ to, text: contactNoticeSmsText(change.lang) });
    if (result.kind === "refused") {
      say(deps, asker, "player.notice_failed", { channel, reason: result.reason });
      return;
    }
    say(deps, asker, "player.notice_sent", {
      channel,
      outcome: result.kind === "sent" ? "sent" : `unknown_${result.reason}`,
    });
  } catch (error) {
    say(deps, asker, "player.notice_failed", { channel, reason: reasonOf(error) });
  }
}

/**
 * Confirms a change with its code (FR-125, FR-139): the account takes the new contact only now. The old value of that
 * channel and the other channel are told (T-108 Revision 1, ADR-120).
 */
export async function confirmContactCode(
  deps: PlayerSignInDeps,
  input: Readonly<{
    playerId: string;
    /** The hash of the request's own access token: a change made here marks this family fresh (ADR-715). */
    session: Buffer;
    challengeToken: string;
    code: string;
    lang: Lang;
    requestId: string;
  }>,
  asker: Asker,
): Promise<ContactConfirmResult> {
  const failures = failureCountsOf(deps, input.playerId, asker.address);
  const result = await asPlayer(deps, input.playerId, async (client) => {
    const full = await firstFull(client, failures);
    if (full !== undefined) {
      return full;
    }
    const { rows } = await client.query<Confirmed>(
      "SELECT * FROM confirm_contact_change($1, $2, $3, $4)",
      [
        input.session,
        tokenHash(input.challengeToken),
        codeHash(deps, input.challengeToken, typedCode(input.code)),
        input.requestId,
      ],
    );
    const row = onlyRow(rows, "confirm_contact_change");
    if (row.outcome === "wrong") {
      await recordAll(client, failures);
    }
    return row;
  });
  if ("retryAfterSeconds" in result) {
    return result;
  }
  if (result.outcome === "wrong") {
    say(deps, asker, "player.contact_code_failed", {});
    return { kind: "invalid_code", attemptsLeft: result.attempts_left };
  }
  if (result.outcome !== "changed") {
    return { kind: result.outcome };
  }
  say(deps, asker, "player.contact_changed", { channel: result.channel, kind: result.kind });
  const change = { channel: result.channel, kind: result.kind, lang: input.lang };
  // Side by side, each catching its own failure: the change is committed, and two slow gateways in a row would hold
  // the answer past the app's patience (a pg-boss queue takes this over with the workers).
  await Promise.allSettled(
    [result.previous, result.other]
      .filter((to): to is string => to !== null)
      .map((to) => notify(deps, asker, to, change)),
  );
  return { kind: "changed" };
}

const LANG = z.enum(["ar", "en"]).default("ar");
const TOKEN = z.string().min(20).max(200);
const codeBody = z.strictObject({
  channel: z.enum(["phone", "email"]),
  value: z.string().min(1).max(254),
  lang: LANG,
});
const verifyBody = z.strictObject({
  challengeToken: TOKEN,
  code: z.string().min(1).max(20),
  lang: LANG,
});

const playerOf = (request: { player?: { id: string } | undefined }): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
};

function throttledAnswer(reply: FastifyReply, retryAfterSeconds: number) {
  reply.header("retry-after", String(retryAfterSeconds));
  return tooManyAttempts({ retryAfterSeconds });
}

/** Why a contact code was not sent, as its HTTP answer. */
function codeRefused(
  result: Exclude<ContactCodeResult, { kind: "code_sent" }>,
  reply: FastifyReply,
): HttpError {
  switch (result.kind) {
    case "unchanged":
      return contactUnchanged();
    case "locked":
      return contactLocked();
    case "phone_not_supported":
      return phoneNotSupported({ emailOffered: false });
    case "invalid_email":
      return invalidRequest();
    case "throttled":
      return throttledAnswer(reply, result.retryAfterSeconds);
    case "sms_unavailable":
      return smsUnavailable({ emailOffered: false });
    case "email_unavailable":
      return emailUnavailable();
  }
}

/**
 * `POST /v1/me/contact/code` and `POST /v1/me/contact/verify` (T-108; FR-125, FR-139): the signed-in player changes or
 * adds a phone or email with a code sent to it. A resend is a new request. The verify step takes an Idempotency-Key, so
 * a lost answer replays `changed` instead of `expired`.
 */
export function registerContactRoutes(
  app: FastifyInstance,
  deps: PlayerSignInDeps & ProfileDeps,
): void {
  app.post(
    "/v1/me/contact/code",
    { config: { access: "player" }, bodyLimit: 1024 },
    async (request, reply) => {
      const body = parse(codeBody, request.body);
      const result = await requestContactCode(
        deps,
        { playerId: playerOf(request), channel: body.channel, value: body.value, lang: body.lang },
        askerOf(request),
      );
      if (result.kind === "code_sent") {
        return reply.code(202).send({
          challengeToken: result.challengeToken,
          expiresInSeconds: result.expiresInSeconds,
        });
      }
      throw codeRefused(result, reply);
    },
  );

  app.post(
    "/v1/me/contact/verify",
    { config: { access: "player", idempotent: true }, bodyLimit: 1024 },
    async (request, reply) => {
      const body = parse(verifyBody, request.body);
      const playerId = playerOf(request);
      const result = await confirmContactCode(
        deps,
        {
          playerId,
          session: ownSession(request),
          challengeToken: body.challengeToken,
          code: body.code,
          lang: body.lang,
          requestId: request.id,
        },
        askerOf(request),
      );
      switch (result.kind) {
        case "changed":
          return readMe(deps, playerId);
        case "invalid_code":
          throw contactCodeWrong({ attemptsLeft: result.attemptsLeft });
        case "expired":
          throw challengeExpired();
        case "taken":
          throw contactInUse();
        case "throttled":
          throw throttledAnswer(reply, result.retryAfterSeconds);
      }
    },
  );
  // The signed-in devices and their fresh code (T-810c): the account's other sign-in safety doors.
  registerSignedInDeviceRoutes(app, deps);
}
