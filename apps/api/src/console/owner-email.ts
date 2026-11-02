import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  maskEmail,
  ownerEmailCodeEmail,
  ownerEmailStartedEmail,
} from "#src/auth/email/email-change-templates";
import type { EmailSender } from "#src/auth/email/sender";
import { stopLinkOf } from "#src/auth/email-change";
import {
  codeNotSent,
  emailChangeClosed,
  emailChangePending,
  emailTaken,
  invalidEmailChange,
  notFound,
  ownAccount,
  ownerInactive,
  ownerIsAdmin,
  resendLimit,
  resendTooSoon,
  sameEmail,
  tooManyEmailChanges,
} from "#src/auth/http-errors";
import { generateCode, hashToken, type AuthKeys } from "#src/auth/keys";
import { normalizeEmail } from "#src/auth/normalize";
import { takeOutboundMail } from "#src/auth/outbound";
import { door, type Admin } from "#src/console/doors";
import type { HttpError } from "#src/http-error";

/** How the admin checked the caller's identity before starting (ADR-490). */
export const IDENTITY_CHECKS = ["known_phone", "id_document", "contract_contact", "other"] as const;
export type IdentityCheck = (typeof IDENTITY_CHECKS)[number];

/** The code and link stay valid this long (the database's own check holds the same number). */
const VALID_MINUTES = 60;

export type OwnerEmailDeps = Readonly<{
  pool: Pool;
  keys: AuthKeys;
  email: EmailSender;
  dashboardOrigin: string;
  log: (event: string, fields: Readonly<Record<string, string>>) => void;
}>;

export type StartInput = Readonly<{
  organizerId: string;
  newEmail: string;
  identityCheck: IdentityCheck;
  reason: string;
  lang: "ar" | "en";
}>;

type Started = Readonly<{
  changeId: string;
  expiresAt: string;
  oldEmail: string;
  newEmail: string;
  organizerName: string;
}>;

/** The EC refusals of migration 0130, by SQLSTATE and DETAIL. */
const REFUSALS: Readonly<Record<string, () => HttpError>> = {
  EC404: notFound,
  "EC403:own_account": ownAccount,
  "EC403:owner_is_admin": ownerIsAdmin,
  "EC409:same_email": sameEmail,
  "EC409:email_taken": emailTaken,
  "EC409:email_change_pending": emailChangePending,
  "EC409:not_pending": emailChangeClosed,
  "EC409:too_soon": resendTooSoon,
  "EC422:inactive": ownerInactive,
  "EC422:identity": invalidEmailChange,
  "EC422:reason": invalidEmailChange,
  "EC422:email": invalidEmailChange,
  EC429: tooManyEmailChanges,
  "EC429:resends": resendLimit,
};

/** Runs an owner-email door in the admin's seat; its EC refusals come back as HttpErrors. */
async function ownerDoor<T>(pool: Pool, admin: Admin, work: (client: PoolClient) => Promise<T>) {
  try {
    return await door(pool, admin, work);
  } catch (error) {
    const { code, detail } = error as { code?: unknown; detail?: unknown };
    const key = typeof detail === "string" ? `${String(code)}:${detail}` : String(code);
    const refusal = Object.hasOwn(REFUSALS, key) ? REFUSALS[key] : REFUSALS[String(code)];
    if (refusal !== undefined) throw refusal();
    throw error;
  }
}

const confirmLinkOf = (deps: OwnerEmailDeps, changeId: string, lang: "ar" | "en"): string =>
  `${deps.dashboardOrigin}/${lang}/email-change#token=${deps.keys.emailChangeToken(changeId, "confirm")}`;

/** The code email to the new address. @returns whether the transport took it. */
async function sendCode(
  deps: OwnerEmailDeps,
  to: string,
  content: Parameters<typeof ownerEmailCodeEmail>[0],
): Promise<boolean> {
  try {
    await deps.email.send({ to, ...ownerEmailCodeEmail(content) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts an owner email change (ADR-490): the door checks every guard and stores only hashes; the new address gets the
 * code and the link, the old one the notice with the Stop link. A code email that cannot be sent closes the change.
 *
 * @throws HttpError for each refusal of the door, and code_not_sent (502) when the code email failed.
 */
export async function startOwnerEmailChange(
  deps: OwnerEmailDeps,
  admin: Admin,
  input: StartInput,
  requestId: string,
): Promise<Readonly<{ changeId: string; expiresAt: string }>> {
  const changeId = randomUUID();
  const code = generateCode();
  const started = await ownerDoor(deps.pool, admin, async (client) => {
    const { rows } = await client.query<{ r: Started }>(
      "SELECT admin_owner_email_start($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r",
      [
        changeId,
        input.organizerId,
        normalizeEmail(input.newEmail),
        input.identityCheck,
        input.reason,
        Buffer.from(hashToken(deps.keys.emailChangeToken(changeId, "confirm")), "hex"),
        Buffer.from(hashToken(deps.keys.emailChangeToken(changeId, "stop")), "hex"),
        deps.keys.emailChangeCodeHash(changeId, code),
        requestId,
      ],
    );
    return rows[0]?.r as Started;
  });
  const sent =
    (await takeOutboundMail(deps.pool)) &&
    (await sendCode(deps, started.newEmail, {
      code,
      link: confirmLinkOf(deps, changeId, input.lang),
      organizerName: started.organizerName,
      expiresInMinutes: VALID_MINUTES,
    }));
  if (!sent) {
    await ownerDoor(deps.pool, admin, (client) =>
      client.query("SELECT admin_owner_email_send_failed($1, $2)", [changeId, requestId]),
    );
    deps.log("console.owner_email_code_not_sent", { change: changeId });
    throw codeNotSent();
  }
  try {
    await deps.email.send({
      to: started.oldEmail,
      ...ownerEmailStartedEmail({
        newMasked: maskEmail(started.newEmail),
        stopLink: stopLinkOf(deps, changeId, input.lang),
      }),
    });
  } catch {
    deps.log("console.owner_email_notice_failed", { change: changeId });
  }
  return { changeId, expiresAt: started.expiresAt };
}

/**
 * A new code for a pending change; the link stays and the tries are not reset (ADR-490).
 *
 * @throws HttpError email_change_closed, resend_too_soon, resend_limit, not_found, code_not_sent.
 */
export async function resendOwnerEmailCode(
  deps: OwnerEmailDeps,
  admin: Admin,
  input: Readonly<{ changeId: string; lang: "ar" | "en" }>,
  requestId: string,
): Promise<void> {
  const code = generateCode();
  const pending = await ownerDoor(deps.pool, admin, async (client) => {
    const { rows } = await client.query<{ r: { newEmail: string; organizerName: string } }>(
      "SELECT admin_owner_email_resend($1, $2, $3) AS r",
      [input.changeId, deps.keys.emailChangeCodeHash(input.changeId, code), requestId],
    );
    return rows[0]?.r as { newEmail: string; organizerName: string };
  });
  const sent =
    (await takeOutboundMail(deps.pool)) &&
    (await sendCode(deps, pending.newEmail, {
      code,
      link: confirmLinkOf(deps, input.changeId, input.lang),
      organizerName: pending.organizerName,
      expiresInMinutes: VALID_MINUTES,
    }));
  if (!sent) {
    deps.log("console.owner_email_code_not_sent", { change: input.changeId });
    throw codeNotSent();
  }
}

/** Cancels a pending or held change. @throws HttpError email_change_closed, not_found. */
export async function cancelOwnerEmailChange(
  deps: Pick<OwnerEmailDeps, "pool">,
  admin: Admin,
  changeId: string,
  requestId: string,
): Promise<void> {
  await ownerDoor(deps.pool, admin, (client) =>
    client.query("SELECT admin_owner_email_cancel($1, $2)", [changeId, requestId]),
  );
}
