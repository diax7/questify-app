import {
  DEFAULT_COMPOSED_PLAYER_INTRO,
  type ComposedConfig,
  type IntroCardKey,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import { CONFIG_KEY } from "#src/config/remote.ts";
import { introOrderOf, resolveIntroOrder } from "#src/onboarding/intro-order.ts";

const SHIPPED = DEFAULT_COMPOSED_PLAYER_INTRO.cards;
const WAIT = 40;

const configWith = (cards: unknown) => ({
  schemaVersion: 1,
  features: {},
  tuning: {},
  legal: { documents: [] },
  playerIntro: { cards },
});
const ok = (body: unknown, etag = '"v1"'): ApiResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers({ etag }),
});

function memoryStore(cached?: unknown) {
  const data = new Map<string, string>();
  if (cached !== undefined) {
    data.set(CONFIG_KEY, JSON.stringify({ etag: '"old"', body: cached }));
  }
  return {
    data,
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function clientAnswering(...answers: ApiResult[]) {
  const calls: ApiRequest[] = [];
  const client: Client = {
    request: async (request) => {
      calls.push(request);
      return answers.shift() ?? { kind: "network" };
    },
  };
  return { client, calls };
}

const resolveWith = (client: Client, store: ReturnType<typeof memoryStore>) =>
  resolveIntroOrder({ client, store }, WAIT);

describe("the cards to play from a configuration (T-802b)", () => {
  it("is the shipped order without a configuration or with a list that names nothing", () => {
    expect(introOrderOf(undefined)).toEqual(SHIPPED);
    expect(introOrderOf({ playerIntro: { cards: [] } } as unknown as ComposedConfig)).toEqual(
      SHIPPED,
    );
  });

  it("is the list the configuration holds", () => {
    const order: IntroCardKey[] = ["prizes", "join"];
    expect(introOrderOf({ playerIntro: { cards: order } } as unknown as ComposedConfig)).toEqual(
      order,
    );
  });
});

describe("the order the intro plays this time", () => {
  it("is the last working copy at once, and the fresh answer only refreshes the stored copy", async () => {
    const store = memoryStore(configWith(["prizes", "join"]));
    const { client, calls } = clientAnswering(ok(configWith(["points"]), '"new"'));
    expect(await resolveWith(client, store)).toEqual(["prizes", "join"]);
    await new Promise((done) => setTimeout(done, 10));
    expect(calls[0]?.path).toBe("/v1/config");
    const kept = JSON.parse(store.data.get(CONFIG_KEY) ?? "{}") as {
      body: { playerIntro: { cards: string[] } };
    };
    expect(kept.body.playerIntro.cards).toEqual(["points"]);
  });

  it("is the fresh answer when the phone holds no copy", async () => {
    const { client } = clientAnswering(ok(configWith(["quests", "points"])));
    expect(await resolveWith(client, memoryStore())).toEqual(["quests", "points"]);
  });

  it("is the shipped order when there is no copy and no answer", async () => {
    expect(await resolveWith(clientAnswering().client, memoryStore())).toEqual(SHIPPED);
  });

  it("is the shipped order when the server does not answer in time, and never waits longer", async () => {
    const silent: Client = { request: () => new Promise(() => undefined) };
    const started = Date.now();
    expect(await resolveWith(silent, memoryStore())).toEqual(SHIPPED);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("plays the shipped order when the answer is late, and the late answer still refreshes the stored copy", async () => {
    const store = memoryStore();
    const late: Client = {
      request: () =>
        new Promise((done) =>
          setTimeout(() => done(ok(configWith(["prizes", "points"]))), WAIT * 3),
        ),
    };
    expect(await resolveWith(late, store)).toEqual(SHIPPED);
    expect(store.data.has(CONFIG_KEY)).toBe(false);
    await new Promise((done) => setTimeout(done, WAIT * 6));
    const kept = JSON.parse(store.data.get(CONFIG_KEY) ?? "{}") as {
      body: { playerIntro: { cards: string[] } };
    };
    expect(kept.body.playerIntro.cards).toEqual(["prizes", "points"]);
    // The next launch plays what the late answer chose, at once.
    expect(await resolveWith(clientAnswering().client, store)).toEqual(["prizes", "points"]);
  });

  it("is the shipped order when the request fails outright", async () => {
    const broken: Client = { request: () => Promise.reject(new Error("socket closed")) };
    expect(await resolveWith(broken, memoryStore())).toEqual(SHIPPED);
  });

  it("skips a card an older app does not know, from the copy", async () => {
    const copy = memoryStore(configWith(["mascot", "points", "ghost", "join"]));
    expect(await resolveWith(clientAnswering().client, copy)).toEqual(["points", "join"]);
  });

  it("is the shipped order when the copy names only cards this app lacks, or is damaged", async () => {
    for (const cards of [["mascot"], "x", null, {}]) {
      const store = memoryStore(configWith(cards));
      expect(await resolveWith(clientAnswering().client, store), JSON.stringify(cards)).toEqual(
        SHIPPED,
      );
    }
  });

  it("is the shipped order for a copy saved before the intro could be edited", async () => {
    const { playerIntro: _unused, ...older } = configWith(["join"]);
    expect(await resolveWith(clientAnswering().client, memoryStore(older))).toEqual(SHIPPED);
  });
});
