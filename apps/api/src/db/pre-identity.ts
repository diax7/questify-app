import type { Client, PoolClient } from "pg";

/**
 * How sign-in finds one row before it knows who the caller is. Each kind opens exactly one row:
 * the account with that email, the session with that token hash, or the challenge with that token hash.
 */
export type Lookup =
  | Readonly<{ kind: "email"; email: string }>
  | Readonly<{ kind: "session"; tokenHash: string }>
  | Readonly<{ kind: "challenge"; tokenHash: string }>;

/** What the work may do once it has found the row: continue as that user, and open a new challenge. */
export type Identify = Readonly<{
  /** Continue the same transaction as this staff user. The id must come from a database row. */
  promote: (staffUserId: string) => Promise<void>;
  /** Make the challenge with this token hash visible (needed to read back a challenge just created). */
  openChallenge: (tokenHash: string) => Promise<void>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

const SETTINGS = [
  "app.organizer_id",
  "app.player_id",
  "app.staff_user_id",
  "app.is_admin",
  "app.auth_email",
  "app.session_token_hash",
  "app.challenge_token_hash",
] as const;

function checkedHash(name: string, value: string): string {
  if (!HASH.test(value)) {
    throw new RangeError(`${name} must be 64 lowercase hex characters.`);
  }
  return value;
}

function lookupSetting(lookup: Lookup): readonly [string, string] {
  switch (lookup.kind) {
    case "email": {
      if (
        lookup.email.length > MAX_EMAIL_LENGTH ||
        lookup.email !== lookup.email.toLowerCase() ||
        !EMAIL.test(lookup.email)
      ) {
        throw new RangeError("email must be a normalized (lowercase) address.");
      }
      return ["app.auth_email", lookup.email];
    }
    case "session":
      return ["app.session_token_hash", checkedHash("tokenHash", lookup.tokenHash)];
    case "challenge":
      return ["app.challenge_token_hash", checkedHash("tokenHash", lookup.tokenHash)];
  }
}

async function set(client: Client | PoolClient, name: string, value: string): Promise<void> {
  await client.query("SELECT set_config($1, $2, true)", [name, value]);
}

/**
 * Runs `work` in one transaction that can see exactly the one row `lookup` names, and nothing else,
 * until `work` promotes itself to the user it found. Only sign-in code calls this; no request value
 * reaches a setting without the format checks above. These paths are a thinner wall than
 * `withRequestContext`, because trusted code (not the caller's identity) opens the row.
 *
 * @throws RangeError when the lookup value or a promoted id is malformed. Rolls back and rethrows when `work` throws,
 *   so callers return failures as values when the outcome must be recorded.
 */
export async function withPreIdentityContext<T>(
  client: Client | PoolClient,
  lookup: Lookup,
  work: (identify: Identify) => Promise<T>,
): Promise<T> {
  const [name, value] = lookupSetting(lookup);
  await client.query("BEGIN");
  try {
    for (const setting of SETTINGS) {
      await set(client, setting, "");
    }
    await set(client, name, value);
    const result = await work({
      promote: async (staffUserId) => {
        if (!UUID.test(staffUserId)) {
          throw new RangeError("staffUserId must be a UUID.");
        }
        await set(client, "app.staff_user_id", staffUserId);
      },
      openChallenge: async (tokenHash) =>
        set(client, "app.challenge_token_hash", checkedHash("tokenHash", tokenHash)),
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
