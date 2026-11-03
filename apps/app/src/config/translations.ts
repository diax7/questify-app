import { NO_OVERRIDES, readOverrides, type Overrides } from "@questify/shared";
import type { Client } from "#src/api/client.ts";
import type { KeyValueStore } from "#src/config/remote.ts";

export const TRANSLATIONS_KEY = "questify.translations";

/** How often a phone in the foreground asks again; an unchanged answer is a 304 with no body. */
export const TRANSLATIONS_REFRESH_MS = 30_000;

/** The longest random wait added to a phone's first refresh and its interval, so phones that start together drift apart. */
export const TRANSLATIONS_JITTER_MS = 5_000;

/** A random wait of 0 up to `TRANSLATIONS_JITTER_MS` (the random source is a parameter for tests). */
export const refreshJitterMs = (random: () => number = Math.random): number =>
  Math.floor(random() * TRANSLATIONS_JITTER_MS);

type Cached = Readonly<{ etag: string | null; body: unknown }>;

async function readCached(store: KeyValueStore): Promise<Cached | undefined> {
  const raw = await store.getItem(TRANSLATIONS_KEY);
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Cached>;
    return { etag: typeof parsed.etag === "string" ? parsed.etag : null, body: parsed.body };
  } catch {
    // A copy that is not JSON is as good as none: the next answer replaces it.
    return undefined;
  }
}

/** The last working copy of the texts an admin changed, or none; what the app shows before the network answers. */
export async function cachedTranslations(store: KeyValueStore): Promise<Overrides> {
  const cached = await readCached(store);
  return cached === undefined ? NO_OVERRIDES : readOverrides(cached.body);
}

/**
 * The texts an admin changed in the console (`GET /v1/translations`, T-702), revalidated with the ETag. A failed fetch, a
 * 304 or an answer the app cannot read keeps the last working copy (F-282); with none, nothing is overridden and every
 * text is the one shipped in the app. Which values are usable is decided when a text is shown (`createTranslator`).
 */
export async function loadTranslations(
  deps: Readonly<{ client: Client; store: KeyValueStore }>,
): Promise<Overrides> {
  const cached = await readCached(deps.store);
  const answer = await deps.client.request({
    method: "GET",
    path: "/v1/translations",
    ...(cached?.etag == null ? {} : { headers: { "if-none-match": cached.etag } }),
  });
  if (answer.kind === "ok" && typeof answer.body === "object" && answer.body !== null) {
    try {
      await deps.store.setItem(
        TRANSLATIONS_KEY,
        JSON.stringify({ etag: answer.headers.get("etag"), body: answer.body } satisfies Cached),
      );
    } catch {
      // The copy could not be kept, so the next start shows the shipped texts until the next answer; this answer still shows.
    }
    return readOverrides(answer.body);
  }
  return cached === undefined ? NO_OVERRIDES : readOverrides(cached.body);
}
