import type { Pool, PoolClient } from "pg";
import {
  maskEmail,
  ownerEmailChangedNewEmail,
  ownerEmailChangedOldEmail,
  ownerEmailHeldEmail,
} from "#src/auth/email/email-change-templates";
import type { EmailSender } from "#src/auth/email/sender";
import { hashToken, type AuthKeys } from "#src/auth/keys";
import { addressBucket } from "#src/auth/normalize";
import { dummyVerify, verifyPassword } from "#src/auth/password";
import { reasonOf, say, type Caller } from "#src/auth/sign-in";
import { BUCKETS } from "#src/auth/throttle";
import { GateBusyError, type VerifyGate } from "#src/auth/verify-gate";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack, type DeviceLimit } from "#src/devices/limits";

/** 20 views, confirms or stops per client address in 15 minutes on the three public routes. */
export const EMAIL_CHANGE_ADDRESS_LIMIT = {
  bucket: BUCKETS.emailChangeAddress,
  max: 20,
  windowSeconds: 900,
} as const satisfies DeviceLimit;

export type EmailChangeDeps = Readonly<{
  pool: Pool;
  keys: AuthKeys;
  email: EmailSender;
  gate: VerifyGate;
  dashboardOrigin: string;
}>;

/** The change a confirm link opens, as the public page sees it. */
export type EmailChangeView = Readonly<{
  organizerName: string;
  newEmailMasked: string;
  expiresAt: string;
}>;

/** What the owner's confirm came to; `held` waits 24 hours because the password was not given. */
export type ConfirmOutcome =
  | Readonly<{ kind: "confirmed"; email: string }>
  | Readonly<{ kind: "held"; appliesAt: string }>
  | Readonly<{ kind: "wrong"; attemptsLeft: number }>
  | Readonly<{ kind: "invalid" | "locked" | "email_taken" | "busy" }>;

/** An applied change as the database answers it (`owner_email_apply`). */
export type Applied = Readonly<{
  outcome: string;
  changeId?: string;
  oldEmail?: string;
  newEmail?: string;
  appliesAt?: string;
}>;

type Viewed = Readonly<{
  changeId: string;
  staffUserId: string;
  newEmail: string;
  expiresAt: string;
  organizerName: string;
}>;

const system = <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> =>
  withConnection(pool, (client) => withRequestContext(client, {}, () => work(client)));

/** The Stop link for a change, in the language of the page it opens. */
export const stopLinkOf = (
  deps: Pick<EmailChangeDeps, "keys" | "dashboardOrigin">, changeId: string, lang = "ar"): string =>
  `${deps.dashboardOrigin}/${lang}/email-change/stop#token=${deps.keys.emailChangeToken(changeId, "stop")}`;

/**
 * Holds one public call against the client address's limit, the wait on `reply` as Retry-After.
 *
 * @throws HttpError too_many_attempts
 */
export async function admitEmailChangeCall(
  deps: Pick<EmailChangeDeps, "pool" | "keys">,
  caller: Caller,
  reply: Readonly<{ header: (name: string, value: string) => unknown }>,
): Promise<void> {
  const key = deps.keys.addressKey(addressBucket(caller.address));
  await holdBack(deps.pool, [{ limit: EMAIL_CHANGE_ADDRESS_LIMIT, key }], true, reply);
}

async function viewOf(deps: EmailChangeDeps, token: string): Promise<Viewed | undefined> {
  const tokenHash = Buffer.from(hashToken(token), "hex");
  return system(deps.pool, async (client) => {
    const { rows } = await client.query<{ r: Viewed | null }>("SELECT owner_email_view($1) AS r", [
      tokenHash,
    ]);
    return rows[0]?.r ?? undefined;
  });
}

/**
 * Sends the two notices of an applied change: the new address its new sign-in email, the old one the masked new address
 * and the Stop link (which now alerts support). A failed send is logged with the change id only; it never undoes the
 * change.
 */
export async function mailApplied(
  deps: EmailChangeDeps,
  applied: Applied,
  log: (event: string, fields: Readonly<Record<string, string>>) => void,
): Promise<void> {
  const { changeId, oldEmail, newEmail } = applied;
  if (changeId === undefined || oldEmail === undefined || newEmail === undefined) return;
  const messages = [
    {
      to: newEmail,
      ...ownerEmailChangedNewEmail({ email: newEmail, dashboardOrigin: deps.dashboardOrigin }),
    },
    {
      to: oldEmail,
      ...ownerEmailChangedOldEmail({
        newMasked: maskEmail(newEmail),
        stopLink: stopLinkOf(deps, changeId),
      }),
    },
  ];
  for (const message of messages) {
    try {
      await deps.email.send(message);
    } catch (error) {
      log("staff.email_change_notice_failed", { change: changeId, reason: reasonOf(error) });
    }
  }
}

/** Checks the account's current password through the verify gate; NULL when the owner said they do not know it. */
async function passwordMatches(
  deps: EmailChangeDeps,
  staffUserId: string,
  password: string | null,
): Promise<boolean | null> {
  if (password === null) return null;
  const stored = await withConnection(deps.pool, (client) =>
    withRequestContext(client, { staffUserId }, async () => {
      const { rows } = await client.query<{ password_hash: string }>(
        "SELECT password_hash FROM staff_user WHERE id = $1 AND status = 'active'",
        [staffUserId],
      );
      return rows[0]?.password_hash;
    }),
  );
  return deps.gate.run(async () => {
    if (stored === undefined) {
      await dummyVerify(password);
      return false;
    }
    return verifyPassword(stored, password);
  });
}

/** The public view of a confirm link. Undefined: unknown, expired or closed, all alike. */
async function view(
  deps: EmailChangeDeps,
  token: string,
  caller: Caller,
): Promise<EmailChangeView | undefined> {
  const found = await viewOf(deps, token);
  if (found === undefined) return undefined;
  return {
    organizerName: found.organizerName,
    newEmailMasked: maskEmail(found.newEmail),
    expiresAt: found.expiresAt,
  };
}

async function confirm(
  deps: EmailChangeDeps,
  input: Readonly<{ token: string; code: string; password: string | null }>,
  caller: Caller,
): Promise<ConfirmOutcome> {
  const found = await viewOf(deps, input.token);
  if (found === undefined) return { kind: "invalid" };
  let passwordOk: boolean | null;
  try {
    passwordOk = await passwordMatches(deps, found.staffUserId, input.password);
  } catch (error) {
    if (error instanceof GateBusyError) return { kind: "busy" };
    throw error;
  }
  const answer = await system(deps.pool, async (client) => {
    const { rows } = await client.query<{ r: Applied & { attemptsLeft?: number } }>(
      "SELECT owner_email_confirm($1, $2, $3, $4) AS r",
      [
        Buffer.from(hashToken(input.token), "hex"),
        deps.keys.emailChangeCodeHash(found.changeId, input.code),
        passwordOk,
        caller.requestId ?? null,
      ],
    );
    return rows[0]?.r ?? { outcome: "invalid" };
  });
  return settle(deps, found, answer, caller);
}

/** Turns the door's answer into the route's, sending the notices a held or applied change needs. */
async function settle(
  deps: EmailChangeDeps,
  found: Viewed,
  answer: Applied & { attemptsLeft?: number },
  caller: Caller,
): Promise<ConfirmOutcome> {
  const log = (event: string, fields: Readonly<Record<string, string>>) =>
    say(deps, caller, event, fields);
  switch (answer.outcome) {
    case "wrong":
      say(deps, caller, "staff.email_change_wrong", { change: found.changeId });
      return { kind: "wrong", attemptsLeft: answer.attemptsLeft ?? 0 };
    case "locked":
    case "email_taken":
      return { kind: answer.outcome };
    case "held": {
      const appliesAt = answer.appliesAt ?? "";
      await mailHeld(deps, answer, log);
      say(deps, caller, "staff.email_change_held", { change: found.changeId });
      return { kind: "held", appliesAt };
    }
    case "confirmed":
      await mailApplied(deps, answer, log);
      say(deps, caller, "staff.email_change_confirmed", { change: found.changeId });
      return { kind: "confirmed", email: answer.newEmail ?? found.newEmail };
    default:
      return { kind: "invalid" };
  }
}

async function mailHeld(
  deps: EmailChangeDeps,
  held: Applied,
  log: (event: string, fields: Readonly<Record<string, string>>) => void,
): Promise<void> {
  const { changeId, oldEmail, newEmail, appliesAt } = held;
  if (
    changeId === undefined ||
    oldEmail === undefined ||
    newEmail === undefined ||
    appliesAt === undefined
  ) {
    return;
  }
  try {
    await deps.email.send({
      to: oldEmail,
      ...ownerEmailHeldEmail({
        newMasked: maskEmail(newEmail),
        appliesAt: new Date(appliesAt),
        stopLink: stopLinkOf(deps, changeId),
      }),
    });
  } catch (error) {
    log("staff.email_change_notice_failed", { change: changeId, reason: reasonOf(error) });
  }
}

/** The old address's Stop: `stopped`, `reported` (after completion: support alerted) or `none`. */
async function stop(deps: EmailChangeDeps, token: string, caller: Caller): Promise<string> {
  const outcome = await system(deps.pool, async (client) => {
    const { rows } = await client.query<{ r: string }>("SELECT owner_email_stop($1, $2) AS r", [
      Buffer.from(hashToken(token), "hex"),
      caller.requestId ?? null,
    ]);
    return rows[0]?.r ?? "none";
  });
  say(deps, caller, "staff.email_change_stop", { outcome });
  return outcome;
}

export type EmailChange = Readonly<{
  /** The per-address limit of the three public routes (Retry-After on `reply`). */
  admit: (
    caller: Caller,
    reply: Readonly<{ header: (name: string, value: string) => unknown }>,
  ) => Promise<void>;
  view: (token: string, caller: Caller) => Promise<EmailChangeView | undefined>;
  confirm: (
    input: Readonly<{ token: string; code: string; password: string | null }>,
    caller: Caller,
  ) => Promise<ConfirmOutcome>;
  stop: (token: string, caller: Caller) => Promise<string>;
}>;

/**
 * The owner's side of an email change (T-701b, ADR-490..492): the confirm link's view, the confirm with the code and
 * the current password (or without it, a 24-hour hold), and the old address's Stop. Tokens come in POST bodies only;
 * logs carry the change id and outcomes, never an address, a token or a code.
 */
export function createEmailChange(deps: EmailChangeDeps): EmailChange {
  return {
    admit: (caller, reply) => admitEmailChangeCall(deps, caller, reply),
    view: (token, caller) => view(deps, token, caller),
    confirm: (input, caller) => confirm(deps, input, caller),
    stop: (token, caller) => stop(deps, token, caller),
  };
}
