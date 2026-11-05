import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { reauthCodeEmail } from "#src/auth/email/templates";
import {
  challengeExpired,
  contactCodeWrong,
  emailUnavailable,
  noContact,
  smsUnavailable,
  tooManyAttempts,
  unauthenticated,
} from "#src/auth/http-errors";
import { generateCode, generateToken, hashToken } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS } from "#src/auth/limits";
import { addressBucket } from "#src/auth/normalize";
import { parse } from "#src/auth/request";
import { reasonOf, say } from "#src/auth/sign-in";
import { BUCKETS } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { onlyRow } from "#src/db/rows";
import { asDevicePlayer, ownSession } from "#src/players/devices";
import { askerOf } from "#src/players/routes";
import {
  holdWindows,
  typedCode,
  type Asker,
  type Lang,
  type PlayerSignInDeps,
} from "#src/players/sign-in";
import {
  firstFull,
  recordAll,
  sendCounts,
  withSendBudget,
  type Channel,
  type Count,
  type Throttled,
  type Unavailable,
} from "#src/players/sign-in-limits";

const L = PLAYER_SIGN_IN_LIMITS;

export type ReauthCodeResult =
  | Readonly<{
      kind: "code_sent";
      challengeToken: string;
      expiresInSeconds: number;
      sentTo: string;
    }>
  | Readonly<{ kind: "no_contact" }>
  | Throttled
  | Unavailable;

export type ReauthConfirmResult =
  | Readonly<{ kind: "confirmed"; freshUntil: Date }>
  | Readonly<{ kind: "invalid_code"; attemptsLeft: number }>
  | Readonly<{ kind: "expired" }>
  | Throttled;

/** The re-authentication SMS (one segment; it says what the code is for, CST 4.6.2). */
export function reauthSmsText(code: string, lang: Lang): string {
  return lang === "ar"
    ? `رمز تأكيد هويتك في كويستفاي: ${code}. لا تشاركه مع أحد.`
    : `Your Questify code to confirm it's you: ${code}. Never share it.`;
}

const tokenHash = (token: string): Buffer => Buffer.from(hashToken(token), "hex");

/** A code's hash, bound to its own challenge by the token's hash. */
const codeHash = (deps: PlayerSignInDeps, token: string, code: string): Buffer =>
  deps.keys.playerCodeHash(hashToken(token), code);

type Opened = Readonly<{
  kind: "opened";
  token: string;
  code: string;
  contact: Readonly<{ channel: Channel; value: string }>;
  sentTo: string;
}>;

/** Rolls the request's transaction back with its answer: nothing was sent, so nothing is counted. */
class NotOpened extends Error {
  constructor(readonly answer: Readonly<{ kind: "no_contact" }> | Throttled) {
    // Stryker disable next-line StringLiteral: never shown: the error is caught in openReauth
    super("the re-authentication code was not opened");
  }
}

/**
 * In the player's transaction: replaces this family's code (`start_player_reauth`, which reads the account's own
 * contact), then holds the sign-in send windows of that contact, install and address; a refusal rolls it all back.
 */
async function startReauth(
  deps: PlayerSignInDeps,
  client: PoolClient,
  input: Readonly<{ session: Buffer; channel: Channel }>,
  asker: Asker,
): Promise<Opened> {
  const token = generateToken().token;
  const code = generateCode();
  const { rows } = await client.query<{
    outcome: "started" | "no_contact";
    contact: string | null;
    masked: string | null;
  }>("SELECT * FROM start_player_reauth($1, $2, $3, $4)", [
    input.session,
    input.channel,
    tokenHash(token),
    codeHash(deps, token, code),
  ]);
  const row = onlyRow(rows, "start_player_reauth");
  if (row.outcome !== "started" || row.contact === null || row.masked === null) {
    throw new NotOpened({ kind: "no_contact" });
  }
  const contact = { channel: input.channel, value: row.contact };
  const counts = sendCounts(deps.keys, contact, asker.address, asker.deviceId);
  const where = { step: "reauth_code", channel: contact.channel, contact: contact.value };
  const refused = await holdWindows(deps, client, counts, asker, where);
  if (refused !== undefined) {
    throw new NotOpened(refused);
  }
  return { kind: "opened", token, code, contact, sentTo: row.masked };
}

/** One unit of the platform send budget around the transaction; the unit is given back unless the code opened. */
async function openReauth(
  deps: PlayerSignInDeps,
  input: Readonly<{ playerId: string; session: Buffer; channel: Channel }>,
  asker: Asker,
): Promise<Opened | Readonly<{ kind: "no_contact" }> | Throttled | Unavailable> {
  return withConnection(deps.pool, (client) =>
    withSendBudget(
      { deps, asker, client, channel: input.channel },
      () =>
        withRequestContext(client, { playerId: input.playerId }, () =>
          startReauth(deps, client, input, asker),
        ).catch((error: unknown) => {
          if (error instanceof NotOpened) {
            return error.answer;
          }
          if ((error as { code?: unknown }).code === "PN401") {
            throw unauthenticated();
          }
          throw error;
        }),
      (opened) => opened.kind === "opened",
    ),
  );
}

async function sendCode(
  deps: PlayerSignInDeps,
  asker: Asker,
  opened: Opened,
  lang: Lang,
): Promise<"sent" | Unavailable["kind"]> {
  if (opened.contact.channel === "phone") {
    const result = await deps.sms.send({
      to: opened.contact.value,
      text: reauthSmsText(opened.code, lang),
    });
    if (result.kind === "refused") {
      say(deps, asker, "player.sms_refused", { gateway: deps.sms.name, reason: result.reason });
      return "sms_unavailable";
    }
    say(deps, asker, "player.reauth_code_sent", { channel: "phone" });
    return "sent";
  }
  try {
    await deps.email.send({
      to: opened.contact.value,
      ...reauthCodeEmail({ code: opened.code, expiresInMinutes: L.codeLifetimeSeconds / 60 }),
    });
    say(deps, asker, "player.reauth_code_sent", { channel: "email" });
    return "sent";
  } catch (error) {
    say(deps, asker, "player.email_unavailable", { reason: reasonOf(error) });
    return "email_unavailable";
  }
}

/**
 * Sends a fresh code to the account's own phone or email (T-810c, ASVS V7.5.2) before this phone signs the others
 * out, against the sign-in send windows and the platform budget. The answer shows the contact masked only.
 */
export async function requestReauthCode(
  deps: PlayerSignInDeps,
  input: Readonly<{ playerId: string; session: Buffer; channel: Channel; lang: Lang }>,
  asker: Asker,
): Promise<ReauthCodeResult> {
  const opened = await openReauth(deps, input, asker);
  if (opened.kind !== "opened") {
    return opened;
  }
  const sent = await sendCode(deps, asker, opened, input.lang);
  if (sent !== "sent") {
    return { kind: sent };
  }
  return {
    kind: "code_sent",
    challengeToken: opened.token,
    expiresInSeconds: L.codeLifetimeSeconds,
    sentTo: opened.sentTo,
  };
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

/** Confirms this family's code (`confirm_player_reauth`); wrong codes count in the player's failure windows. */
export async function confirmReauthCode(
  deps: PlayerSignInDeps,
  input: Readonly<{
    playerId: string;
    session: Buffer;
    challengeToken: string;
    code: string;
    requestId: string;
  }>,
  asker: Asker,
): Promise<ReauthConfirmResult> {
  const failures = failureCountsOf(deps, input.playerId, asker.address);
  const result = await asDevicePlayer(deps.pool, input.playerId, async (client) => {
    const full = await firstFull(client, failures);
    if (full !== undefined) {
      return full;
    }
    const { rows } = await client.query<{
      outcome: "expired" | "wrong" | "confirmed";
      attempts_left: number;
      fresh_until: Date | null;
    }>("SELECT * FROM confirm_player_reauth($1, $2, $3, $4)", [
      input.session,
      tokenHash(input.challengeToken),
      codeHash(deps, input.challengeToken, typedCode(input.code)),
      input.requestId,
    ]);
    const row = onlyRow(rows, "confirm_player_reauth");
    if (row.outcome === "wrong") {
      await recordAll(client, failures);
    }
    return row;
  });
  if ("retryAfterSeconds" in result) {
    return result;
  }
  if (result.outcome === "confirmed" && result.fresh_until !== null) {
    return { kind: "confirmed", freshUntil: result.fresh_until };
  }
  if (result.outcome === "wrong") {
    say(deps, asker, "player.reauth_code_failed", {});
    return { kind: "invalid_code", attemptsLeft: result.attempts_left };
  }
  return { kind: "expired" };
}

const codeBody = z.strictObject({
  channel: z.enum(["phone", "email"]),
  lang: z.enum(["ar", "en"]).default("ar"),
});
const verifyBody = z.strictObject({
  challengeToken: z.string().min(20).max(200),
  code: z.string().min(1).max(20),
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

/**
 * `POST /v1/me/reauth/code` and `POST /v1/me/reauth/verify` (T-810c, FR-140): a fresh code to the player's own phone
 * or email makes this phone's sign-in fresh for 10 minutes, so it may sign the other devices out. The verify step takes
 * an Idempotency-Key, so a lost answer replays `freshUntil` instead of `challenge_expired`.
 */
export function registerReauthRoutes(app: FastifyInstance, deps: PlayerSignInDeps): void {
  app.post(
    "/v1/me/reauth/code",
    { config: { access: "player" }, bodyLimit: 256 },
    async (request, reply) => {
      const body = parse(codeBody, request.body);
      const result = await requestReauthCode(
        deps,
        {
          playerId: playerOf(request),
          session: ownSession(request),
          channel: body.channel,
          lang: body.lang,
        },
        askerOf(request),
      );
      switch (result.kind) {
        case "code_sent":
          return reply.code(202).send({
            challengeToken: result.challengeToken,
            expiresInSeconds: result.expiresInSeconds,
            sentTo: result.sentTo,
          });
        case "no_contact":
          throw noContact();
        case "throttled":
          throw throttledAnswer(reply, result.retryAfterSeconds);
        case "sms_unavailable":
          throw smsUnavailable({ emailOffered: false });
        case "email_unavailable":
          throw emailUnavailable();
      }
    },
  );

  app.post(
    "/v1/me/reauth/verify",
    { config: { access: "player", idempotent: true }, bodyLimit: 1024 },
    async (request, reply) => {
      const body = parse(verifyBody, request.body);
      const result = await confirmReauthCode(
        deps,
        {
          playerId: playerOf(request),
          session: ownSession(request),
          challengeToken: body.challengeToken,
          code: body.code,
          requestId: request.id,
        },
        askerOf(request),
      );
      switch (result.kind) {
        case "confirmed":
          return { freshUntil: result.freshUntil };
        case "invalid_code":
          throw contactCodeWrong({ attemptsLeft: result.attemptsLeft });
        case "expired":
          throw challengeExpired();
        case "throttled":
          throw throttledAnswer(reply, result.retryAfterSeconds);
      }
    },
  );
}
