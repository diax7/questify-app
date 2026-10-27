import { z } from "zod";

/**
 * Marketing consent, interests and the "For you" list (T-407, ADR-316 to ADR-319). Consent is per channel, off until a
 * recorded yes (FR-735); interests and city are private to the player (FR-733).
 */

export const MARKETING_CHANNELS = ["push", "sms", "email"] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

/**
 * The version of the consent wording the app shows. A change to the wording bumps it; the API refuses a consent sent
 * with another version, so a yes is always a yes to the text in force.
 */
export const MARKETING_TEXT_VERSION = "1";

/** At most this many interests on a player, and on an event. */
export const MAX_PLAYER_INTERESTS = 8;
export const MAX_EVENT_INTERESTS = 3;

const bilingual = z.object({ ar: z.string(), en: z.string() });
const interestId = z.string().regex(/^[a-z][a-z0-9-]{1,29}$/);
const channelState = z.object({
  optedIn: z.boolean(),
  /** When this channel last changed; null until the first answer. */
  changedAt: z.string().nullable(),
});

/** `GET /v1/me/marketing`: each channel, whether the sign-up step was answered, whether the player may opt in. */
export const marketingSchema = z.object({
  channels: z.object({ push: channelState, sms: channelState, email: channelState }),
  asked: z.boolean(),
  canOptIn: z.boolean(),
});
export type Marketing = z.infer<typeof marketingSchema>;

/** The slice of `GET /v1/me` the app's one-time consent step reads. */
export const marketingSummarySchema = z.object({ asked: z.boolean(), canOptIn: z.boolean() });
export type MarketingSummary = z.infer<typeof marketingSummarySchema>;

/** `PUT /v1/me/marketing`: the channels named are set; the others stay as they are. */
export const marketingBodySchema = z.strictObject({
  textVersion: z.string().regex(/^[0-9]+(\.[0-9]+){0,2}$/),
  method: z.enum(["signup", "settings"]),
  channels: z
    .strictObject({ push: z.boolean(), sms: z.boolean(), email: z.boolean() })
    .partial()
    .refine((channels) => Object.keys(channels).length > 0, "name at least one channel"),
});
export type MarketingBody = z.infer<typeof marketingBodySchema>;

/** Why a consent was refused (409 `consent_text_outdated` carries the version in force). */
export const consentOutdatedSchema = z.object({ textVersion: z.string() });

/** The interest catalog (`GET /v1/interests`). */
export const interestSchema = z.object({ id: interestId, name: bilingual });
export type Interest = z.infer<typeof interestSchema>;
export const interestsSchema = z.object({ interests: z.array(interestSchema) });

/** `GET` and `PUT /v1/me/preferences`: both fields, always (a null city and an empty list clear them). */
export const preferencesSchema = z.object({
  cityId: z.string().min(1).max(40).nullable(),
  interests: z.array(interestId).max(MAX_PLAYER_INTERESTS),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const preferencesBodySchema = z.strictObject({
  cityId: z.string().min(1).max(40).nullable(),
  interests: z
    .array(interestId)
    .max(MAX_PLAYER_INTERESTS)
    .refine((ids) => new Set(ids).size === ids.length, "each interest once"),
});
export type PreferencesBody = z.infer<typeof preferencesBodySchema>;

/** The fields a 422 `invalid_preferences` can name. */
export const invalidPreferencesSchema = z.object({ field: z.enum(["cityId", "interests"]) });

/** One recommended event (`GET /v1/me/for-you`): the public event card plus its city and interests. */
export const forYouEventSchema = z.object({
  id: z.uuid(),
  joinCode: z.string(),
  name: z.object({ ar: z.string().nullable(), en: z.string().nullable() }),
  venue: z.object({ ar: z.string().nullable(), en: z.string().nullable() }),
  kind: z.string(),
  timezone: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  statusNow: z.enum(["scheduled", "live"]),
  city: bilingual.nullable(),
  interests: z.array(interestId),
});
export type ForYouEvent = z.infer<typeof forYouEventSchema>;
export const forYouSchema = z.object({ events: z.array(forYouEventSchema) });

/** `POST /v1/public/marketing/opt-out`: the signed token from the link in a promotional message. */
export const optOutBodySchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,80}$/),
});

/** A platform admin's read of one player's consent (FR-1113). */
export const consentHistorySchema = z.object({
  channels: z.object({ push: channelState, sms: channelState, email: channelState }),
  history: z.array(
    z.object({
      channel: z.enum(MARKETING_CHANNELS),
      granted: z.boolean(),
      method: z.enum(["signup", "settings", "opt_out_link"]),
      textVersion: z.string().nullable(),
      at: z.string(),
    }),
  ),
});
export type ConsentHistory = z.infer<typeof consentHistorySchema>;
