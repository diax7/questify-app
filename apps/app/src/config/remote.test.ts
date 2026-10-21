import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import { CONFIG_KEY, consentVersions, loadConfig, signupVersions } from "#src/config/remote.ts";

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
