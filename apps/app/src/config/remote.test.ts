import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import {
  DEFAULT_COMPOSED_LAYOUT,
  DEFAULT_COMPOSED_QUESTIFY_HOME,
  DEFAULT_TERMS,
  QUESTIFY_HOME_KEYS,
  type ComposedQuestifyHome,
  type EventTerms,
} from "@questify/shared";
import {
  CONFIG_KEY,
  configKeyOf,
  consentVersions,
  loadConfig,
  loadEventConfig,
  loadPlatformConfig,
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

const GOOD = JSON.stringify({ etag: '"v1"', body: CONFIG });
const STORED: Record<
  string,
  { raw: string | undefined; sentTag: string | undefined; usable: boolean }
> = {
  none: { raw: undefined, sentTag: undefined, usable: false },
  good: { raw: GOOD, sentTag: '"v1"', usable: true },
  goodNoTag: { raw: JSON.stringify({ body: CONFIG }), sentTag: undefined, usable: true },
  numericTag: { raw: JSON.stringify({ etag: 4, body: CONFIG }), sentTag: undefined, usable: true },
  unreadableBody: {
    raw: JSON.stringify({ etag: '"v1"', body: { schemaVersion: 9 } }),
    sentTag: '"v1"',
    usable: false,
  },
  noBody: { raw: JSON.stringify({ etag: '"v1"' }), sentTag: '"v1"', usable: false },
  notJson: { raw: "{not json", sentTag: undefined, usable: false },
};
const SERVER_ERROR: ApiResult = { ...notModified, status: 500, code: "x" };

async function runLoad(
  stored: string | undefined,
  answer: ApiResult | { kind: "signed_out" },
  options: Parameters<typeof loadConfig>[1],
) {
  const key = options !== undefined && "event" in options ? `${CONFIG_KEY}.e1` : CONFIG_KEY;
  const calls: ApiRequest[] = [];
  const written: string[] = [];
  const result = await loadConfig(
    {
      client: {
        request: async (request) => {
          calls.push(request as ApiRequest);
          return answer;
        },
      },
      store: {
        getItem: async (name) => (name === key ? (stored ?? null) : null),
        setItem: async (name, value) => {
          written.push(`${name}=${value}`);
        },
      },
    },
    options,
  );
  return { result, calls, written, key };
}

describe("loadConfig, every scenario", () => {
  it.each(Object.entries(STORED))(
    "asks with the tag of a %s copy only when it revalidates",
    async (_name, { raw, sentTag }) => {
      for (const options of [{}, { revalidate: true }, { event: "e1" }]) {
        const { calls } = await runLoad(raw, { kind: "network" }, options);
        expect(calls[0]?.headers).toEqual(
          sentTag === undefined ? undefined : { "if-none-match": sentTag },
        );
      }
      for (const options of [{ revalidate: false }, { event: "e1", revalidate: false }]) {
        const { calls } = await runLoad(raw, { kind: "network" }, options);
        expect(calls[0]?.headers).toBeUndefined();
      }
    },
  );

  it("asks the platform's address, or the event's when one is named", async () => {
    expect((await runLoad(GOOD, { kind: "network" }, {})).calls).toEqual([
      { method: "GET", path: "/v1/config", headers: { "if-none-match": '"v1"' } },
    ]);
    expect((await runLoad(undefined, { kind: "network" }, { event: "e1" })).calls).toEqual([
      { method: "GET", path: "/v1/events/e1/config" },
    ]);
  });

  it.each(Object.entries(STORED))(
    "keeps a fresh answer over a %s copy, with its tag or null, under the scope's key",
    async (_name, { raw }) => {
      for (const options of [{}, { revalidate: false }, { event: "e1" }]) {
        const key = "event" in options ? `${CONFIG_KEY}.e1` : CONFIG_KEY;
        const tagged = await runLoad(raw, ok(CONFIG, '"n"'), options);
        expect(tagged.result).toMatchObject({ schemaVersion: 1 });
        expect(tagged.written).toEqual([`${key}=${JSON.stringify({ etag: '"n"', body: CONFIG })}`]);
        const untagged = await runLoad(raw, ok(CONFIG), options);
        expect(untagged.written).toEqual([
          `${key}=${JSON.stringify({ etag: null, body: CONFIG })}`,
        ]);
      }
    },
  );

  it.each(Object.entries(STORED))(
    "falls back to a %s copy when the answer is unreadable, unchanged or failed, and writes nothing",
    async (_name, { raw, usable }) => {
      const answers = [
        ok({ schemaVersion: 2 }),
        notModified,
        SERVER_ERROR,
        { kind: "network" } as const,
        { kind: "signed_out" } as const,
      ];
      for (const answer of answers) {
        for (const options of [{}, { event: "e1" }]) {
          const { result, written } = await runLoad(raw, answer, options);
          expect(written).toEqual([]);
          if (usable) {
            expect(result).toMatchObject({ schemaVersion: 1, legal: CONFIG.legal });
          } else {
            expect(result).toBeUndefined();
          }
        }
      }
    },
  );
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

describe("an event's layout", () => {
  const moved = {
    bar: ["rewards", "index", "scan", "profile"],
    home: DEFAULT_COMPOSED_LAYOUT.home,
  };

  it("shows a saved layout, from the fresh answer and again from the cached copy offline", async () => {
    const store = memoryStore();
    const fresh = await loadConfig(
      { client: fake([ok({ ...CONFIG, layout: moved }, '"l1"')]).client, store },
      { event: "a" },
    );
    expect(fresh?.layout.bar).toEqual(moved.bar);
    const offline = { client: fake([]).client, store };
    expect((await loadConfig(offline, { event: "a" }))?.layout.bar).toEqual(moved.bar);
  });

  it("reads a copy saved before layouts as Questify's layout", async () => {
    const store = memoryStore();
    store.data.set(configKeyOf("old"), JSON.stringify({ etag: null, body: CONFIG }));
    const loaded = await loadConfig({ client: fake([]).client, store }, { event: "old" });
    expect(loaded?.layout).toEqual(DEFAULT_COMPOSED_LAYOUT);
  });

  it.each([
    ["hides the scan button", { bar: ["index", "quests", "rewards", "profile"], home: [] }],
    ["is not a layout at all", "scanner off"],
  ])("falls back to Questify's layout when the cached copy %s", async (_name, layout) => {
    const store = memoryStore();
    store.data.set(configKeyOf("bad"), JSON.stringify({ etag: null, body: { ...CONFIG, layout } }));
    const loaded = await loadConfig({ client: fake([]).client, store }, { event: "bad" });
    expect(loaded?.layout.bar).toEqual(DEFAULT_COMPOSED_LAYOUT.bar);
    expect(loaded?.layout.home).toEqual(DEFAULT_COMPOSED_LAYOUT.home);
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

describe("loadPlatformConfig (T-713)", () => {
  const moved: ComposedQuestifyHome = {
    blocks: [...QUESTIFY_HOME_KEYS].toReversed(),
    banner: [
      {
        title: { ar: "", en: "Hello" },
        subtitle: { ar: "", en: "" },
        action: { type: "none" },
      },
    ],
  };

  it("shows the last working layout first, then the fresh one", async () => {
    const store = memoryStore({ etag: '"h1"', body: { ...CONFIG, questifyHome: moved } });
    const shown: ComposedQuestifyHome[] = [];
    const fresh = { ...moved, blocks: QUESTIFY_HOME_KEYS };
    const { client, calls } = fake([ok({ ...CONFIG, questifyHome: fresh }, '"h2"')]);
    await loadPlatformConfig({ client, store }, (config) => shown.push(config.questifyHome));
    expect(shown).toStrictEqual([moved, fresh]);
    expect(calls[0]?.path).toBe("/v1/config");
    expect(calls[0]?.headers).toEqual({ "if-none-match": '"h1"' });
  });

  it("keeps the last working layout when the fresh answer cannot be read", async () => {
    const store = memoryStore({ etag: '"h1"', body: { ...CONFIG, questifyHome: moved } });
    const shown: ComposedQuestifyHome[] = [];
    const client = fake([ok({ nonsense: true })]).client;
    await loadPlatformConfig({ client, store }, (config) => shown.push(config.questifyHome));
    expect(shown).toStrictEqual([moved, moved]);
  });

  it("shows nothing with no copy and no answer, so Home keeps the order it always had", async () => {
    const shown: ComposedQuestifyHome[] = [];
    await loadPlatformConfig({ client: fake([]).client, store: memoryStore() }, (config) =>
      shown.push(config.questifyHome),
    );
    expect(shown).toStrictEqual([]);
  });

  it("reads a copy from before the layout existed, or a damaged one, as the default order", async () => {
    const bodies = [
      CONFIG,
      { ...CONFIG, questifyHome: "x" },
      { ...CONFIG, questifyHome: { blocks: ["quests"] } },
    ];
    for (const body of bodies) {
      const shown: ComposedQuestifyHome[] = [];
      const store = memoryStore({ etag: null, body });
      await loadPlatformConfig({ client: fake([]).client, store }, (config) =>
        shown.push(config.questifyHome),
      );
      expect(shown.at(-1)).toStrictEqual(DEFAULT_COMPOSED_QUESTIFY_HOME);
    }
  });
});
