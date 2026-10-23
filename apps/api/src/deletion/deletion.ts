import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Deferred } from "#src/auth/deferred";
import { deletionCodeEmail } from "#src/auth/email/templates";
import { generateCode, generateToken, hashToken } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS } from "#src/auth/limits";
import { addressBucket } from "#src/auth/normalize";
import { reasonOf, say } from "#src/auth/sign-in";
import { BUCKETS, tryLock } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { onlyRow } from "#src/db/rows";
import type { IdempotencyStore } from "#src/idempotency-store";
import {
  contactOf,
  typedCode,
  type Asker,
  type Lang,
  type PlayerSignInDeps,
} from "#src/players/sign-in";
import {
  firstFull,
  recordAll,
  sendCounts,
  takePlatformBudget,
  type Channel,
  type Count,
  type Throttled,
} from "#src/players/sign-in-limits";

const L = PLAYER_SIGN_IN_LIMITS;
const DELETION_TOKEN_SECONDS = 600;

export type DeletionDeps = PlayerSignInDeps &
  Readonly<{
    /** Sends a public request's code after the answer, so a known and an unknown contact answer alike. */
    deferred: Deferred;
    /** The deleted player's remembered answers are dropped with the account. */
    idempotencyStore: IdempotencyStore;
  }>;

type Unavailable = Readonly<{ kind: "sms_unavailable" | "email_unavailable" }>;
type Contact = Readonly<{ channel: Channel; value: string }>;

export type CodeResult =
  | Readonly<{ kind: "code_sent"; challengeToken: string; expiresInSeconds: number }>
  | Readonly<{ kind: "phone_not_supported" | "invalid_email" }>
  | Throttled
  | Unavailable;

/** A handover still waiting (FR-128): a reserved shop prize or a rank prize at the desk. */
export type PendingHandover = Readonly<{
  redemptionId: string;
  eventId: string;
  event: Readonly<{ ar: string | null; en: string | null }>;
  item: Readonly<{ ar: string | null; en: string | null }>;
  rankPrize: boolean;
}>;

export type VerifyResult =
  | Readonly<{
      kind: "verified";
      deletionToken: string;
      expiresInSeconds: number;
      pending: readonly PendingHandover[];
    }>
  | Readonly<{ kind: "invalid_code"; attemptsLeft: number }>
  | Readonly<{ kind: "expired" }>
  | Throttled;

export type ConfirmResult =
  | Readonly<{ kind: "erased" | "expired" }>
  | Readonly<{ kind: "handover_pending"; pending: readonly PendingHandover[] }>;

const tokenHash = (token: string): Buffer => Buffer.from(hashToken(token), "hex");

const asSystem = <T>(deps: DeletionDeps, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) => withRequestContext(client, {}, () => work(client)));

/** The deletion SMS (one segment each; it says what the code is for, CST 4.6.2). */
export function deletionSmsText(code: string, lang: Lang): string {
  return lang === "ar"
    ? `رمز حذف حسابك في كويستفاي: ${code}. لا تشاركه مع أحد.`
    : `Your Questify account deletion code is ${code}. Do not share it.`;
}

/**
 * Opens the deletion challenge inside the sign-in send windows and platform budget, under a lock on the contact. True
 * in `known` when an account uses the contact: only then is a code sent.
 */
async function openChallenge(
  deps: DeletionDeps,
  contact: Contact,
  asker: Asker,
): Promise<
  | Readonly<{ kind: "opened"; token: string; code: string; known: boolean }>
  | Throttled
  | Unavailable
> {
  return asSystem(deps, async (client) => {
    const counts = sendCounts(deps.keys, contact.value, asker.address, asker.deviceId);
    // Stryker disable next-line ConditionalExpression,BlockStatement,ObjectLiteral: lock contention on one contact: timing, not a path a test can hold
    if (!(await tryLock(client, deps.keys.contactThrottleKey(contact.value)))) {
      return { kind: "throttled", retryAfterSeconds: 1 } as const;
    }
    const full = await firstFull(client, counts);
    if (full !== undefined) {
      say(deps, asker, "player.throttled", { step: "deletion_code", channel: contact.channel });
      return full;
    }
    if ((await takePlatformBudget(client, contact.channel)) === "spent") {
      say(deps, asker, "player.budget_spent", { channel: contact.channel });
      return {
        kind: contact.channel === "phone" ? "sms_unavailable" : "email_unavailable",
      } as const;
    }
    await recordAll(client, counts);
    const id = randomUUID();
    const token = generateToken().token;
    const code = generateCode();
    const { rows } = await client.query<{ known: boolean }>(
      "SELECT start_deletion_challenge($1, $2, $3, $4, $5, $6) AS known",
      [
        id,
        tokenHash(token),
        contact.channel,
        contact.value,
        deps.keys.contactLookupKey(contact.value),
        deps.keys.deletionCodeHash(hashToken(token), code),
      ],
    );
    return {
      kind: "opened",
      token,
      code,
      known: onlyRow(rows, "start_deletion_challenge").known,
    } as const;
  });
}

/** Sends the code; a refusal is logged and answered, never thrown. */
async function deliver(
  deps: DeletionDeps,
  asker: Asker,
  send: Readonly<{ contact: Contact; code: string; lang: Lang }>,
): Promise<"sent" | Unavailable["kind"]> {
  if (send.contact.channel === "phone") {
    const result = await deps.sms.send({
      to: send.contact.value,
      text: deletionSmsText(send.code, send.lang),
    });
    if (result.kind === "refused") {
      say(deps, asker, "player.sms_refused", { gateway: deps.sms.name, reason: result.reason });
      return "sms_unavailable";
    }
    say(deps, asker, "player.deletion_code_sent", { channel: "phone" });
    return "sent";
  }
  try {
    await deps.email.send({
      to: send.contact.value,
      ...deletionCodeEmail({ code: send.code, expiresInMinutes: L.codeLifetimeSeconds / 60 }),
    });
    say(deps, asker, "player.deletion_code_sent", { channel: "email" });
    return "sent";
  } catch (error) {
    say(deps, asker, "player.email_unavailable", { reason: reasonOf(error) });
    return "email_unavailable";
  }
}

const sent = (token: string): CodeResult => ({
  kind: "code_sent",
  challengeToken: token,
  expiresInSeconds: L.codeLifetimeSeconds,
});

/**
 * The web page's code request (FR-127): always the same answer, and a challenge is always written; the code goes out
 * after the answer, and only when an account uses the contact. Whether one does is never said.
 */
export async function requestCode(
  deps: DeletionDeps,
  input: Readonly<{ channel: Channel; value: string; lang: Lang }>,
  asker: Asker,
): Promise<CodeResult> {
  const contact = contactOf(input.channel, input.value);
  if ("kind" in contact) {
    return contact;
  }
  const opened = await openChallenge(deps, contact, asker);
  if (opened.kind !== "opened") {
    return opened;
  }
  if (opened.known) {
    deps.deferred.defer(async () => {
      await deliver(deps, asker, { contact, code: opened.code, lang: input.lang });
    });
  }
  return sent(opened.token);
}

/** The signed-in player's own phone (or email when there is none, or when asked), as the database holds it. */
async function ownContact(
  deps: DeletionDeps,
  playerId: string,
  preferred: Channel | undefined,
): Promise<Contact | undefined> {
  const order: Channel[] = preferred === "email" ? ["email", "phone"] : ["phone", "email"];
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      for (const channel of order) {
        const { rows } = await client.query<{ value: string | null }>(
          "SELECT own_deletion_contact($1) AS value",
          [channel],
        );
        const value = rows[0]?.value ?? null;
        if (value !== null) {
          return { channel, value };
        }
      }
      return undefined;
    }),
  );
}

/** The app's code request (FR-126): to the account's own contact, sent before the answer so a failure can be said. */
export async function requestOwnCode(
  deps: DeletionDeps,
  input: Readonly<{ playerId: string; channel: Channel | undefined; lang: Lang }>,
  asker: Asker,
): Promise<CodeResult> {
  const contact = await ownContact(deps, input.playerId, input.channel);
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: every account holds a phone or an email
  if (contact === undefined) {
    return { kind: "invalid_email" };
  }
  const opened = await openChallenge(deps, contact, asker);
  if (opened.kind !== "opened") {
    return opened;
  }
  const delivered = await deliver(deps, asker, { contact, code: opened.code, lang: input.lang });
  return delivered === "sent" ? sent(opened.token) : { kind: delivered };
}

function failureCountsOf(deps: DeletionDeps, address: string): Count[] {
  return [
    {
      bucket: BUCKETS.playerFailAddress,
      key: deps.keys.addressKey(addressBucket(address)),
      limit: L.failuresPerAddress,
    },
  ];
}

async function pendingOf(client: PoolClient, deletionHash: Buffer): Promise<PendingHandover[]> {
  const { rows } = await client.query<{
    redemption_id: string;
    event_id: string;
    event_ar: string | null;
    event_en: string | null;
    item_ar: string | null;
    item_en: string | null;
    rank_prize: boolean;
  }>("SELECT * FROM deletion_pending($1)", [deletionHash]);
  return rows.map((row) => ({
    redemptionId: row.redemption_id,
    eventId: row.event_id,
    event: { ar: row.event_ar, en: row.event_en },
    item: { ar: row.item_ar, en: row.item_en },
    rankPrize: row.rank_prize,
  }));
}

/** Checks the deletion code; a right one gives a 10-minute deletion token and the handovers still pending. */
export async function verifyCode(
  deps: DeletionDeps,
  input: Readonly<{ challengeToken: string; code: string }>,
  asker: Asker,
): Promise<VerifyResult> {
  const failures = failureCountsOf(deps, asker.address);
  const deletionToken = generateToken().token;
  const result = await asSystem(deps, async (client): Promise<VerifyResult> => {
    const full = await firstFull(client, failures);
    if (full !== undefined) {
      return full;
    }
    const { rows } = await client.query<{ outcome: string; attempts_left: number }>(
      "SELECT * FROM verify_deletion_code($1, $2, $3)",
      [
        tokenHash(input.challengeToken),
        deps.keys.deletionCodeHash(hashToken(input.challengeToken), typedCode(input.code)),
        tokenHash(deletionToken),
      ],
    );
    const row = onlyRow(rows, "verify_deletion_code");
    if (row.outcome === "wrong") {
      await recordAll(client, failures);
      return { kind: "invalid_code", attemptsLeft: row.attempts_left };
    }
    if (row.outcome !== "verified") {
      return { kind: "expired" };
    }
    return {
      kind: "verified",
      deletionToken,
      expiresInSeconds: DELETION_TOKEN_SECONDS,
      pending: await pendingOf(client, tokenHash(deletionToken)),
    };
  });
  if (result.kind === "invalid_code") {
    say(deps, asker, "player.deletion_code_failed");
  }
  return result;
}

/**
 * Deletes the account behind the deletion token (FR-126, FR-127). A pending handover needs `forfeit`. The token is the
 * idempotency key: a repeat after success answers `erased` while the token's row lives.
 */
export async function confirmDeletion(
  deps: DeletionDeps,
  input: Readonly<{ deletionToken: string; forfeit: boolean; requestId: string }>,
  asker: Asker,
): Promise<ConfirmResult> {
  const hash = tokenHash(input.deletionToken);
  const result = await asSystem(
    deps,
    async (client): Promise<ConfirmResult & { player?: string }> => {
      const { rows } = await client.query<{ outcome: string; player_id: string | null }>(
        "SELECT outcome, player_id FROM erase_player($1, $2, $3)",
        [hash, input.forfeit, input.requestId],
      );
      const row = onlyRow(rows, "erase_player");
      if (row.outcome === "handover_pending") {
        return { kind: "handover_pending", pending: await pendingOf(client, hash) };
      }
      if (row.outcome === "erased" && row.player_id !== null) {
        return { kind: "erased", player: row.player_id };
      }
      return { kind: row.outcome === "replayed" ? "erased" : "expired" };
    },
  );
  if (result.kind === "erased" && result.player !== undefined) {
    await deps.idempotencyStore.forget(`player:${result.player}`);
    say(deps, asker, "player.deleted", { player: result.player });
  }
  if (result.kind === "handover_pending") {
    return { kind: "handover_pending", pending: result.pending };
  }
  return { kind: result.kind };
}
