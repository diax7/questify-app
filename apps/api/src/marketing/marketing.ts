import type {
  ConsentHistory,
  ForYouEvent,
  Interest,
  Marketing,
  MarketingBody,
  MarketingChannel,
  Preferences,
  PreferencesBody,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { consentAge, invalidPreferences, notFound, unauthenticated } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/**
 * The player's marketing consent, preferences and "For you" list (T-407, migration 0070). Every door binds the caller
 * from the request context and re-checks an active player, so none can name another player; the one that takes a
 * player id (the opt-out link's) is called only after the link's signature is checked.
 */

type PgError = Readonly<{ code?: string; detail?: string }>;

/** Turns the doors' SQLSTATEs into HTTP errors; anything else is a server fault and is rethrown. */
export function refusalOf(error: unknown): never {
  const { code, detail } = error as PgError;
  if (code === "PI401") throw unauthenticated();
  if (code === "MK403") throw consentAge();
  if (code === "PF422") throw invalidPreferences({ field: detail });
  if (code === "QY403" || code === "QY404") throw notFound();
  throw error;
}

async function one<T>(client: PoolClient, sql: string, values: unknown[] = []): Promise<T> {
  try {
    const { rows } = await client.query<{ r: T }>(sql, values);
    return rows[0]?.r as T;
  } catch (error) {
    return refusalOf(error);
  }
}

/** The caller's consent: each channel, whether the sign-up step was answered, whether they may opt in. */
export const readMarketing = (client: PoolClient): Promise<Marketing> =>
  one(client, "SELECT own_marketing() AS r");

/**
 * The language a consent is given in, from the request's `accept-language` (the app sends `ar` or `en` on every call):
 * its first tag's language when that is Arabic or English, else null (read as Arabic when a promotion is sent, ADR-331
 * (6)).
 */
export function consentLanguage(header: unknown): "ar" | "en" | null {
  if (typeof header !== "string") return null;
  const first = header.split(",")[0]?.trim().toLowerCase().split(/[-;_]/)[0];
  return first === "ar" || first === "en" ? first : null;
}

/**
 * Sets the channels named (all or nothing); a channel whose state does not change writes nothing. Each row written
 * records the language of the screen it was given on.
 */
export const setMarketing = (
  client: PoolClient,
  body: MarketingBody,
  language: "ar" | "en" | null = null,
): Promise<Marketing> =>
  one(client, "SELECT set_marketing($1::jsonb, $2, $3, $4) AS r", [
    JSON.stringify(body.channels),
    body.method,
    body.textVersion,
    language,
  ]);

/** The caller's city and interests (private; never part of a public profile). */
export const readPreferences = (client: PoolClient): Promise<Preferences> =>
  one(client, "SELECT own_preferences() AS r");

/** Replaces the caller's city and interests. */
export const setPreferences = (client: PoolClient, body: PreferencesBody): Promise<Preferences> =>
  one(client, "SELECT set_preferences($1, $2::text[]) AS r", [body.cityId, body.interests]);

/** The caller's recommended public events. */
export const readForYou = (client: PoolClient): Promise<ForYouEvent[]> =>
  one(client, "SELECT own_for_you() AS r");

/** The seeded interest catalog, in its order. */
export const readInterests = (client: PoolClient): Promise<Interest[]> =>
  one(client, "SELECT interest_list() AS r");

/** What the opt-out link did: `opted_out`, `already_off`, or `gone` (no such player). */
export type OptOutOutcome = "opted_out" | "already_off" | "gone";

/** Turns one channel off for a player named by a verified link. */
export const optOutChannel = (
  client: PoolClient,
  playerId: string,
  channel: MarketingChannel,
): Promise<OptOutOutcome> =>
  one(client, "SELECT marketing_opt_out($1, $2) AS r", [playerId, channel]);

/** A promotion's audience, as the promotional senders ask for it. */
export type AudienceQuery = Readonly<{
  channel: MarketingChannel;
  /** Only players living in this city (null: any). */
  cityId?: string | null;
  /** Only players holding any of these interests (empty or null: any). */
  anyOf?: readonly string[] | null;
  /** The last player id of the previous page. */
  after?: string | null;
  /** At most 1000. */
  pageSize: number;
}>;

/**
 * One page of the players a promotion on a channel may reach: active, opted in on that channel now. Every promotional
 * sender (push, SMS, email, invitations) chooses its recipients here and nowhere else (FR-737, FR-1111); it reads this
 * at send time, so an opt-out takes effect at once. Ids only.
 */
export async function readPromoAudience(
  client: PoolClient,
  query: AudienceQuery,
): Promise<string[]> {
  const { rows } = await client.query<{ player_id: string }>(
    "SELECT player_id FROM marketing_audience($1, $2, $3::text[], $4, $5)",
    [
      query.channel,
      query.cityId ?? null,
      query.anyOf === null || query.anyOf === undefined ? null : [...query.anyOf],
      query.after ?? null,
      query.pageSize,
    ],
  );
  return rows.map((row) => row.player_id);
}

/** One platform admin's read of a player's consent; the database checks the admin again and audits the read. */
export async function readConsentHistory(
  pool: Pool,
  adminId: string,
  playerId: string,
  requestId: string,
): Promise<ConsentHistory> {
  return withConnection(pool, (client) =>
    withRequestContext(client, { isAdmin: true, staffUserId: adminId }, () =>
      one<ConsentHistory>(client, "SELECT marketing_consent_history($1, $2) AS r", [
        playerId,
        requestId,
      ]),
    ),
  );
}
