import {
  citiesSchema,
  forYouSchema,
  interestsSchema,
  marketingSchema,
  preferencesSchema,
  type City,
  type ForYouEvent,
  type Interest,
  type Marketing,
  type MarketingBody,
  type Preferences,
  type PreferencesBody,
} from "@questify/shared";
import { readOk, type Reader } from "#src/questify/questify-api.ts";

/** The caller's consent per channel; null when the answer is missing or odd (never shown as "everything off"). */
export const fetchMarketing = (session: Reader): Promise<Marketing | null> =>
  readOk(session, "/v1/me/marketing", marketingSchema);

/** The caller's city and interests; null when unreadable. */
export const fetchPreferences = (session: Reader): Promise<Preferences | null> =>
  readOk(session, "/v1/me/preferences", preferencesSchema);

/** The seeded interests, in their order; null when unreadable. */
export async function fetchInterests(session: Reader): Promise<readonly Interest[] | null> {
  return (await readOk(session, "/v1/interests", interestsSchema))?.interests ?? null;
}

/** The seeded cities, in their order; null when unreadable. */
export async function fetchCities(session: Reader): Promise<readonly City[] | null> {
  return (await readOk(session, "/v1/cities", citiesSchema))?.cities ?? null;
}

/** The recommended events; null when unreadable, so a failed read is never shown as "nothing for you". */
export async function fetchForYou(session: Reader): Promise<readonly ForYouEvent[] | null> {
  return (await readOk(session, "/v1/me/for-you", forYouSchema))?.events ?? null;
}

/** What a consent save came to (ADR-316, ADR-317). */
export type ConsentOutcome =
  | Readonly<{ kind: "saved"; marketing: Marketing }>
  /** The wording changed since this build: nothing was saved. */
  | Readonly<{ kind: "outdated" }>
  /** The account may not opt in: nothing was saved. */
  | Readonly<{ kind: "age" }>
  | Readonly<{ kind: "limited" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

type Writer = Pick<Reader, "request">;

/** Sets the channels named. A repeat of the same body is harmless: the server writes only what changes. */
export async function saveMarketing(session: Writer, body: MarketingBody): Promise<ConsentOutcome> {
  const answer = await session.request({ method: "PUT", path: "/v1/me/marketing", body });
  if (answer.kind === "signed_out" || answer.kind === "network") return { kind: answer.kind };
  if (answer.kind === "ok") {
    const marketing = marketingSchema.safeParse(answer.body);
    return marketing.success ? { kind: "saved", marketing: marketing.data } : { kind: "failed" };
  }
  if (answer.code === "consent_text_outdated") return { kind: "outdated" };
  if (answer.code === "consent_age") return { kind: "age" };
  return answer.status === 429 ? { kind: "limited" } : { kind: "failed" };
}

/** What a preferences save came to. */
export type PreferencesOutcome =
  | Readonly<{ kind: "saved"; preferences: Preferences }>
  /** The server does not know the city or an interest (the lists moved): read them again. */
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "limited" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

/** Replaces the caller's city and interests. */
export async function savePreferences(
  session: Writer,
  body: PreferencesBody,
): Promise<PreferencesOutcome> {
  const answer = await session.request({ method: "PUT", path: "/v1/me/preferences", body });
  if (answer.kind === "signed_out" || answer.kind === "network") return { kind: answer.kind };
  if (answer.kind === "ok") {
    const preferences = preferencesSchema.safeParse(answer.body);
    return preferences.success
      ? { kind: "saved", preferences: preferences.data }
      : { kind: "failed" };
  }
  if (answer.code === "invalid_preferences") return { kind: "invalid" };
  return answer.status === 429 ? { kind: "limited" } : { kind: "failed" };
}
