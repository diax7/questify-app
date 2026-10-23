import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import { DEFAULT_TERMS, type EventTerms } from "@questify/shared";
import {
  CONFIG_KEY,
  configKeyOf,
  consentVersions,
  loadConfig,
  loadEventConfig,
  signupVersions,
} from "#src/config/remote.ts";

const CONFIG = {
  schemaVersion: 1,
  features: {},
  tuning: {},
  legal: {
    documents: [
      { id: "terms_of_use", version: "0.2" },
      { id: "privacy_policy", version: "0.1" },
      { id: "community_guidelines", version: "0.1" },
      { id: "cookie_policy", version: "9.9" },
    ],
  },
};

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
    data.set(CONFIG_KEY, JSON.stringify(initial));
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

describe("loadConfig", () => {
  it("keeps a fresh answer with its tag, and asks with the tag next time", async () => {
    const store = memoryStore();
    const first = fake([ok(CONFIG, '"v1"')]);
    expect(await loadConfig({ client: first.client, store })).toMatchObject({ schemaVersion: 1 });
    expect(JSON.parse(store.data.get(CONFIG_KEY) ?? "")).toEqual({ etag: '"v1"', body: CONFIG });
    const second = fake([notModified]);
    expect(await loadConfig({ client: second.client, store })).toMatchObject({ schemaVersion: 1 });
    expect(second.calls[0]?.headers).toEqual({ "if-none-match": '"v1"' });
  });

  it("keeps the last working copy when the network fails or the answer cannot be read", async () => {
    for (const answer of [{ kind: "network" } as const, ok({ schemaVersion: 2 }), notModified]) {
      const store = memoryStore({ etag: '"v1"', body: CONFIG });
      expect(await loadConfig({ client: fake([answer]).client, store })).toMatchObject({
        legal: CONFIG.legal,
      });
      expect(JSON.parse(store.data.get(CONFIG_KEY) ?? "").body).toEqual(CONFIG);
    }
  });

  it("has nothing without a working copy, and asks without a tag", async () => {
    for (const cached of [undefined, { etag: 3, body: { broken: true } }]) {
      const store = memoryStore(cached);
      const { client, calls } = fake([{ kind: "network" }]);
      expect(await loadConfig({ client, store })).toBeUndefined();
      expect(calls[0]?.headers).toBeUndefined();
    }
    const unreadable = memoryStore();
    unreadable.data.set(CONFIG_KEY, "not json");
    expect(
      await loadConfig({ client: fake([{ kind: "network" }]).client, store: unreadable }),
    ).toBeUndefined();
  });
});

describe("the consent versions", () => {
  it("reads the terms and privacy in force, ignoring other documents", () => {
    expect(signupVersions(CONFIG as never)).toEqual({ terms: "0.2", privacy: "0.1" });
    expect(signupVersions(undefined)).toBeUndefined();
    expect(
      signupVersions({
        ...CONFIG,
        legal: { documents: [{ id: "terms_of_use", version: "1" }] },
      } as never),
    ).toBeUndefined();
  });

  it("refetches in full when the cached copy predates the legal block", async () => {
    const old = { ...CONFIG, legal: undefined };
    const store = memoryStore({ etag: '"old"', body: old });
    const { client, calls } = fake([notModified, ok(CONFIG, '"v2"')]);
    expect(await consentVersions({ client, store })).toEqual({ terms: "0.2", privacy: "0.1" });
    expect(calls.map((call) => call.headers)).toEqual([{ "if-none-match": '"old"' }, undefined]);
  });

  it("answers nothing when even the full fetch has no terms or privacy", async () => {
    const thin = { ...CONFIG, legal: { documents: [] } };
    const { client } = fake([ok(thin), ok(thin)]);
    expect(await consentVersions({ client, store: memoryStore() })).toBeUndefined();
  });
});

const GEMS = {
  ...DEFAULT_TERMS,
  currency: { icon: "gem", ar: { one: "جوهرة", many: "جواهر" }, en: { one: "gem", many: "gems" } },
} satisfies EventTerms;
const LEAVES = {
  ...DEFAULT_TERMS,
  currency: {
    icon: "leaf",
    ar: { one: "ورقة", many: "أوراق" },
    en: { one: "leaf", many: "leaves" },
  },
} satisfies EventTerms;

describe("an event's configuration", () => {
  it("asks the event's own address and keeps a copy per event, beside the platform's", async () => {
    const store = memoryStore({ etag: '"p"', body: CONFIG });
    const a = fake([ok({ ...CONFIG, terms: GEMS }, '"a1"')]);
    const loaded = await loadConfig({ client: a.client, store }, { event: "event-a" });
    expect(loaded?.terms).toStrictEqual(GEMS);
    expect(a.calls[0]).toMatchObject({ method: "GET", path: "/v1/events/event-a/config" });
    expect(a.calls[0]?.headers).toBeUndefined();
    expect(JSON.parse(store.data.get(configKeyOf("event-a")) ?? "").etag).toBe('"a1"');
    expect(JSON.parse(store.data.get(CONFIG_KEY) ?? "")).toEqual({ etag: '"p"', body: CONFIG });
  });

  it("offline, never shows one event's words in another", async () => {
    const store = memoryStore();
    await loadConfig(
      { client: fake([ok({ ...CONFIG, terms: GEMS })]).client, store },
      { event: "a" },
    );
    await loadConfig(
      { client: fake([ok({ ...CONFIG, terms: LEAVES })]).client, store },
      { event: "b" },
    );
    const offline = { client: fake([]).client, store };
    expect((await loadConfig(offline, { event: "a" }))?.terms).toStrictEqual(GEMS);
    expect((await loadConfig(offline, { event: "b" }))?.terms).toStrictEqual(LEAVES);
    expect(await loadConfig(offline, { event: "c" })).toBeUndefined();
  });

  it("keeps the event's copy when the session has ended", async () => {
    const store = memoryStore();
    store.data.set(
      configKeyOf("a"),
      JSON.stringify({ etag: '"a1"', body: { ...CONFIG, terms: GEMS } }),
    );
    const client = { request: async () => ({ kind: "signed_out" }) as const };
    expect((await loadConfig({ client, store }, { event: "a" }))?.terms).toStrictEqual(GEMS);
  });

  it("reads a copy saved before the event's words as the defaults", async () => {
    const store = memoryStore();
    store.data.set(configKeyOf("old"), JSON.stringify({ etag: null, body: CONFIG }));
    expect(
      (await loadConfig({ client: fake([]).client, store }, { event: "old" }))?.terms,
    ).toStrictEqual(DEFAULT_TERMS);
  });
});

describe("loadEventConfig", () => {
  it("shows the cached words first, then the fresh ones", async () => {
    const store = memoryStore();
    store.data.set(
      configKeyOf("a"),
      JSON.stringify({ etag: '"a1"', body: { ...CONFIG, terms: GEMS } }),
    );
    const shown: EventTerms[] = [];
    const { client, calls } = fake([ok({ ...CONFIG, terms: LEAVES }, '"a2"')]);
    await loadEventConfig({ client, store }, "a", (config) => shown.push(config.terms));
    expect(shown).toStrictEqual([GEMS, LEAVES]);
    expect(calls[0]?.headers).toEqual({ "if-none-match": '"a1"' });
  });

  it("shows nothing with no copy and no answer, so the screens keep the defaults", async () => {
    const shown: EventTerms[] = [];
    await loadEventConfig({ client: fake([]).client, store: memoryStore() }, "a", (config) =>
      shown.push(config.terms),
    );
    expect(shown).toStrictEqual([]);
  });

  it("shows the fresh words when nothing was cached", async () => {
    const shown: EventTerms[] = [];
    const client = fake([ok({ ...CONFIG, terms: GEMS })]).client;
    await loadEventConfig({ client, store: memoryStore() }, "a", (config) =>
      shown.push(config.terms),
    );
    expect(shown).toStrictEqual([GEMS]);
  });
});
