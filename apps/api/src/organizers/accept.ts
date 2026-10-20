import type { PoolClient } from "pg";
import { AUTH_LIMITS } from "#src/auth/limits";
import { addressBucket } from "#src/auth/normalize";
import { checkPasswordPolicy } from "#src/auth/password";
import { breachCheckAndHash, type NotSet, type PasswordDeps } from "#src/auth/password-reset";
import { hashToken } from "#src/auth/keys";
import {
  say,
  type Caller,
  type PasswordResult,
  type SignIn,
  type Throttled,
} from "#src/auth/sign-in";
import { findAccountByEmail } from "#src/auth/staff-store";
import { BUCKETS, countRecent, record } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { withPreIdentityContext } from "#src/db/pre-identity";

export type InviteView = Readonly<{
  organizerName: string;
  role: "editor" | "owner";
  email: string;
  accountExists: boolean;
}>;

type Refused = Readonly<{
  kind: "invalid" | "other_account" | "already_member" | "sign_in_to_accept";
}>;

export type InspectResult = Readonly<{ kind: "invite"; invite: InviteView }> | Refused | Throttled;
export type AcceptResult = Readonly<{ kind: "joined"; organizerId: string }> | Refused;
export type AcceptNewResult =
  | Readonly<{ kind: "code_sent"; challengeToken: string; expiresInSeconds: number }>
  | Refused
  | NotSet
  | Throttled
  | Readonly<{ kind: "email_unavailable" }>;

export type Invites = Readonly<{
  inspect: (token: string, caller: Caller) => Promise<InspectResult>;
  accept: (token: string, staffUserId: string, caller: Caller) => Promise<AcceptResult>;
  acceptNew: (
    input: { token: string; password: string },
    caller: Caller,
  ) => Promise<AcceptNewResult>;
}>;

const L = AUTH_LIMITS;

/** The invite functions' own SQLSTATE codes (migration 0008), and an email taken meanwhile. */
const REFUSALS: Readonly<Record<string, Refused["kind"]>> = {
  QI410: "invalid",
  QI403: "other_account",
  QI409: "already_member",
};

function refusalOf(error: unknown): Refused | undefined {
  const pg = error as { code?: string; constraint?: string };
  const kind = REFUSALS[pg.code ?? ""];
  if (kind !== undefined) {
    return { kind };
  }
  return pg.constraint === "staff_user_email_key" ? { kind: "sign_in_to_accept" } : undefined;
}

/** Counts one look or acceptance per client address: each may cost a hash and a breach-list call. */
async function admitAddress(deps: PasswordDeps, caller: Caller): Promise<Throttled | undefined> {
  const key = deps.keys.addressKey(addressBucket(caller.address));
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, async () => {
      const recent = await countRecent(
        client,
        BUCKETS.inviteAddress,
        key,
        L.inviteChecksPerAddress.windowSeconds,
      );
      if (recent.count >= L.inviteChecksPerAddress.max) {
        return { kind: "throttled", retryAfterSeconds: recent.retryAfterSeconds } as const;
      }
      await record(client, BUCKETS.inviteAddress, key);
      return undefined;
    }),
  );
}

type Found = Readonly<{ email: string; role: "editor" | "owner"; organizerName: string }>;

async function readInvite(client: PoolClient): Promise<Found | undefined> {
  const { rows } = await client.query<{
    email: string;
    role: "editor" | "owner";
    organizer_name: string;
  }>(
    `SELECT i.email, i.role, o.name AS organizer_name
     FROM organizer_invite i JOIN organizer o ON o.id = i.organizer_id
     WHERE i.expires_at > now()`,
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { email: row.email, role: row.role, organizerName: row.organizer_name };
}

/** What an invite link opens, before anyone signs in. The holder of the link already proved the mailbox. */
async function inspect(deps: PasswordDeps, token: string, caller: Caller): Promise<InspectResult> {
  const throttled = await admitAddress(deps, caller);
  if (throttled !== undefined) {
    return throttled;
  }
  const found = await withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "invite", tokenHash: hashToken(token) }, () =>
      readInvite(client),
    ),
  );
  if (found === undefined) {
    return { kind: "invalid" };
  }
  const account = await withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "email", email: found.email }, () =>
      findAccountByEmail(client, found.email),
    ),
  );
  return { kind: "invite", invite: { ...found, accountExists: account !== undefined } };
}

/** The signed-in person accepts; the database checks the invite was sent to their own email. */
async function accept(
  deps: PasswordDeps,
  token: string,
  staffUserId: string,
  caller: Caller,
): Promise<AcceptResult> {
  try {
    const organizerId = await withConnection(deps.pool, (client) =>
      withPreIdentityContext(
        client,
        { kind: "invite", tokenHash: hashToken(token) },
        async ({ promote }) => {
          await promote(staffUserId);
          const { rows } = await client.query<{ organizer: string }>(
            "SELECT accept_invite($1) AS organizer",
            [caller.requestId ?? null],
          );
          return rows[0]?.organizer ?? "";
        },
      ),
    );
    say(deps, caller, "staff.invite_accepted", { user: staffUserId });
    return { kind: "joined", organizerId };
  } catch (error) {
    const refused = refusalOf(error);
    if (refused === undefined) {
      throw error;
    }
    return refused;
  }
}

/**
 * Someone without an account accepts: the password passes the same rules as any other, the account is created with
 * the invite's email, and a sign-in code is emailed at once. No session comes from the link alone (ADR-078).
 */
async function acceptNew(
  deps: PasswordDeps,
  signIn: SignIn,
  input: { token: string; password: string },
  caller: Caller,
): Promise<AcceptNewResult> {
  const throttled = await admitAddress(deps, caller);
  if (throttled !== undefined) {
    return throttled;
  }
  const tokenHash = hashToken(input.token);
  const found = await withConnection(deps.pool, (client) =>
    withPreIdentityContext(client, { kind: "invite", tokenHash }, () => readInvite(client)),
  );
  if (found === undefined) {
    return { kind: "invalid" };
  }
  const policy = checkPasswordPolicy(input.password, found.email);
  if (!policy.ok) {
    return { kind: "weak", reason: policy.reason };
  }
  const prepared = await breachCheckAndHash(deps, input.password, caller);
  if (prepared.kind !== "ready") {
    return prepared;
  }
  try {
    await withConnection(deps.pool, (client) =>
      withPreIdentityContext(client, { kind: "invite", tokenHash }, () =>
        client.query("SELECT * FROM accept_invite_new($1, $2)", [
          prepared.hash,
          caller.requestId ?? null,
        ]),
      ),
    );
  } catch (error) {
    const refused = refusalOf(error);
    if (refused === undefined) {
      throw error;
    }
    return refused;
  }
  say(deps, caller, "staff.invite_accepted_new");
  return chainSignIn(
    await signIn.passwordStep({ email: found.email, password: input.password }, caller),
  );
}

/** The new account signs in at once: the sign-in step emails its code, and the web shows the code step. */
function chainSignIn(result: PasswordResult): AcceptNewResult {
  switch (result.kind) {
    case "code_sent":
      return result;
    case "throttled":
    case "challenge_cap":
      return { kind: "throttled", retryAfterSeconds: result.retryAfterSeconds };
    case "busy":
      return { kind: "busy" };
    case "email_unavailable":
    // Stryker disable next-line all: unreachable: the account was created a moment ago with this very password
    case "invalid_credentials":
      return { kind: "email_unavailable" };
  }
}

/** Looking at and accepting team invites (FR-1012, FR-1723). */
export function createInvites(deps: PasswordDeps, signIn: SignIn): Invites {
  return {
    inspect: (token, caller) => inspect(deps, token, caller),
    accept: (token, staffUserId, caller) => accept(deps, token, staffUserId, caller),
    acceptNew: (input, caller) => acceptNew(deps, signIn, input, caller),
  };
}
