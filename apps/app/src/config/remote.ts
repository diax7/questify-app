import { parseComposedConfig, type ComposedConfig, type SignupAcceptance } from "@questify/shared";
import type { Client } from "#src/api/client.ts";

/** The shape of AsyncStorage the config needs (injected, so the logic runs in tests). */
export type KeyValueStore = Readonly<{
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}>;

export const CONFIG_KEY = "questify.config";

type Cached = Readonly<{ etag: string | null; body: unknown }>;

async function readCached(store: KeyValueStore): Promise<Cached | undefined> {
  const raw = await store.getItem(CONFIG_KEY);
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
 * The platform's composed configuration (`GET /v1/config`), revalidated with its ETag. A failed fetch or an answer the
 * app cannot read keeps the last working copy (F-282); with none, it is undefined and the caller says so.
 */
export async function loadConfig(
  deps: Readonly<{ client: Client; store: KeyValueStore }>,
  options: Readonly<{ revalidate?: boolean }> = {},
): Promise<ComposedConfig | undefined> {
  const cached = await readCached(deps.store);
  const etag = options.revalidate === false ? null : (cached?.etag ?? null);
  const answer = await deps.client.request({
    method: "GET",
    path: "/v1/config",
    ...(etag === null ? {} : { headers: { "if-none-match": etag } }),
  });
  if (answer.kind === "error" && answer.status === 304) {
    return usable(cached);
  }
  if (answer.kind === "ok") {
    const parsed = parseComposedConfig(answer.body);
    if (parsed.ok) {
      await deps.store.setItem(
        CONFIG_KEY,
        JSON.stringify({ etag: answer.headers.get("etag"), body: answer.body } satisfies Cached),
      );
      return parsed.config;
    }
  }
  return usable(cached);
}

/** The terms and privacy versions in force, from the documents the config names (unknown ids are ignored). */
export function signupVersions(config: ComposedConfig | undefined): SignupAcceptance | undefined {
  const documents = config?.legal?.documents ?? [];
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
