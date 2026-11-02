import { describe, expect, it } from "vitest";
import { MESSAGES, createTranslator } from "@questify/shared";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import {
  TRANSLATIONS_KEY,
  cachedTranslations,
  loadTranslations,
} from "#src/config/translations.ts";

const BUNDLE = { ar: { "nav.home": "البداية" }, en: { "nav.home": "Start" } };

const ok = (body: unknown, etag?: string): ApiResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(etag === undefined ? {} : { etag }),
});
const notModified: ApiResult = {
  kind: "error",
  status: 304,
  code: "unknown_error",
  message: null,
  details: {},
  headers: new Headers(),
};

function memoryStore(initial?: unknown) {
  const data = new Map<string, string>();
  if (initial !== undefined) {
    data.set(TRANSLATIONS_KEY, typeof initial === "string" ? initial : JSON.stringify(initial));
  }
  return {
    data,
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function fake(answers: ApiResult[]) {
  const calls: ApiRequest[] = [];
  const client: Client = {
    request: async (request) => {
      calls.push(request);
      return answers.shift() ?? { kind: "network" };
    },
  };
  return { client, calls };
}

describe("loadTranslations", () => {
  it("keeps a fresh answer with its tag, and asks with the tag next time", async () => {
    const store = memoryStore();
    const first = fake([ok(BUNDLE, '"v1"')]);
    expect(await loadTranslations({ client: first.client, store })).toEqual(BUNDLE);
    expect(first.calls[0]).toEqual({ method: "GET", path: "/v1/translations" });
    expect(JSON.parse(store.data.get(TRANSLATIONS_KEY) ?? "")).toEqual({
      etag: '"v1"',
      body: BUNDLE,
    });
    const second = fake([notModified]);
    expect(await loadTranslations({ client: second.client, store })).toEqual(BUNDLE);
    expect(second.calls[0]?.headers).toEqual({ "if-none-match": '"v1"' });
  });

  it("replaces the copy when the admin changed a text", async () => {
    const store = memoryStore({ etag: '"v1"', body: BUNDLE });
    const changed = { ar: {}, en: { "nav.home": "Begin" } };
    expect(await loadTranslations({ client: fake([ok(changed, '"v2"')]).client, store })).toEqual(
      changed,
    );
    expect(await cachedTranslations(store)).toEqual(changed);
  });

  it("keeps the last working copy when the network fails or the answer cannot be read", async () => {
    for (const answer of [{ kind: "network" } as const, ok("broken"), ok(null), notModified]) {
      const store = memoryStore({ etag: '"v1"', body: BUNDLE });
      expect(await loadTranslations({ client: fake([answer]).client, store })).toEqual(BUNDLE);
      expect(JSON.parse(store.data.get(TRANSLATIONS_KEY) ?? "").body).toEqual(BUNDLE);
    }
  });

  it("overrides nothing without a working copy, and asks without a tag", async () => {
    for (const cached of [undefined, "not json", { etag: 3, body: "broken" }]) {
      const store = memoryStore(cached);
      const { client, calls } = fake([{ kind: "network" }]);
      expect(await loadTranslations({ client, store })).toEqual({ ar: {}, en: {} });
      expect(calls[0]?.headers).toBeUndefined();
    }
  });

  it("shows the cached texts before the network answers", async () => {
    expect(await cachedTranslations(memoryStore({ etag: null, body: BUNDLE }))).toEqual(BUNDLE);
    expect(await cachedTranslations(memoryStore())).toEqual({ ar: {}, en: {} });
  });

  it("changes a shown text only when the stored one is usable", async () => {
    const broken = { ar: { "quests.pointsShort": "لديك نقاط" }, en: { "nav.home": "Start" } };
    const overrides = await loadTranslations({
      client: fake([ok(broken, '"v1"')]).client,
      store: memoryStore(),
    });
    const t = createTranslator(MESSAGES, overrides);
    expect(t("nav.home", "en")).toBe("Start");
    expect(t("quests.pointsShort", "ar", { points: 3, currency: "x" })).toBe(
      createTranslator(MESSAGES)("quests.pointsShort", "ar", { points: 3, currency: "x" }),
    );
  });
});
