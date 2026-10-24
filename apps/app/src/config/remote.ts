import { parseComposedConfig, type ComposedConfig, type SignupAcceptance } from "@questify/shared";
import type { ApiRequest, Client } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";

/** The shape of AsyncStorage the config needs (injected, so the logic runs in tests). */
export type KeyValueStore = Readonly<{
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}>;

export const CONFIG_KEY = "questify.config";

/** Each scope keeps its own copy and ETag: the platform's, and one per event, so one event never shows another's. */
export const configKeyOf = (event: string | undefined): string =>
  event === undefined ? CONFIG_KEY : `${CONFIG_KEY}.${event}`;

type Cached = Readonly<{ etag: string | null; body: unknown }>;

/** The plain client, or the session for an event's copy: a signed-out answer keeps the last working copy too. */
type ConfigClient = Readonly<{
  request: (request: Omit<ApiRequest, "accessToken">) => Promise<AuthedResult>;
}>;

async function readCached(store: KeyValueStore, key: string): Promise<Cached | undefined> {
  const raw = await store.getItem(key);
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Cached>;
    return { etag: typeof parsed.etag === "string" ? parsed.etag : null, body: parsed.body };
  } catch {
    return undefined;
  }
}

const usable = (cached: Cached | undefined): ComposedConfig | undefined => {
  if (cached === undefined) {
    return undefined;
  }
  const parsed = parseComposedConfig(cached.body);
  return parsed.ok ? parsed.config : undefined;
};

/**
 * The composed configuration, revalidated with its ETag: the platform's (`GET /v1/config`), or with `event` that of an
 * event the player joined (`GET /v1/events/:id/config`, so `client` must carry the session). A failed fetch or an
 * answer the app cannot read keeps the last working copy (F-282); with none, it is undefined and the caller says so.
 */
export async function loadConfig(
  deps: Readonly<{ client: ConfigClient; store: KeyValueStore }>,
  options: Readonly<{ revalidate?: boolean; event?: string }> = {},
): Promise<ComposedConfig | undefined> {
  const key = configKeyOf(options.event);
  const cached = await readCached(deps.store, key);
  const etag = options.revalidate === false ? null : (cached?.etag ?? null);
  const answer = await deps.client.request({
    method: "GET",
    path: options.event === undefined ? "/v1/config" : `/v1/events/${options.event}/config`,
    ...(etag === null ? {} : { headers: { "if-none-match": etag } }),
  });
  if (answer.kind === "error" && answer.status === 304) {
    return usable(cached);
  }
  if (answer.kind === "ok") {
    const parsed = parseComposedConfig(answer.body);
    if (parsed.ok) {
      await deps.store.setItem(
        key,
        JSON.stringify({ etag: answer.headers.get("etag"), body: answer.body } satisfies Cached),
      );
      return parsed.config;
    }
  }
  return usable(cached);
}

/**
 * The event's configuration for the screens (its words, FR-404, FR-940; its switches): the event's cached copy first,
 * so nothing flashes, then the fresh one. With neither, `show` is never called and the screens keep Questify's
 * defaults (every switch read as off where off is the safe side, such as location).
 */
export async function loadEventConfig(
  deps: Readonly<{ client: ConfigClient; store: KeyValueStore }>,
  event: string,
  show: (config: ComposedConfig) => void,
): Promise<void> {
  const cached = usable(await readCached(deps.store, configKeyOf(event)));
  if (cached !== undefined) {
    show(cached);
  }
  const fresh = await loadConfig(deps, { event });
  if (fresh !== undefined) {
    show(fresh);
  }
}

/** Whether the platform's location switch is on in a composed configuration (ADR-208); off when unknown. */
export const locationQuestsOn = (config: ComposedConfig | undefined): boolean =>
  config?.features["locationQuests"]?.enabled === true;

/** Whether the platform's NFC switch is on (ADR-234): on unless the configuration says off. */
export const nfcTagsOn = (config: ComposedConfig | undefined): boolean =>
  config?.features["nfcTags"]?.enabled !== false;

/** The terms and privacy versions in force, from the documents the config names (unknown ids are ignored). */
export function signupVersions(config: ComposedConfig | undefined): SignupAcceptance | undefined {
  return versionsFrom(config?.legal?.documents);
}

/**
 * The terms and privacy versions from a list of `{id, version}` documents: the config's, or a 422
 * `acceptance_required`'s `details.documents`. Anything else, or a list without both, is undefined.
 */
export function versionsFrom(value: unknown): SignupAcceptance | undefined {
  const documents = Array.isArray(value)
    ? value.filter(
        (item): item is { id: string; version: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { id: unknown }).id === "string" &&
          typeof (item as { version: unknown }).version === "string",
      )
    : [];
  const terms = documents.find((document) => document.id === "terms_of_use")?.version;
  const privacy = documents.find((document) => document.id === "privacy_policy")?.version;
  return terms === undefined || privacy === undefined ? undefined : { terms, privacy };
}

/**
 * The versions the consent step shows. A copy cached before the legal block existed is refetched in full (T-110
 * note); when even that has no terms or privacy, undefined: the screen shows an error with retry and never asks for a
 * code without them.
 */
export async function consentVersions(
  deps: Readonly<{ client: Client; store: KeyValueStore }>,
): Promise<SignupAcceptance | undefined> {
  const first = signupVersions(await loadConfig(deps));
  return first ?? signupVersions(await loadConfig(deps, { revalidate: false }));
}
