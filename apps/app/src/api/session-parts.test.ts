import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import {
  MY_QR_KEY,
  SESSION_KEY,
  createRefresher,
  createSessionStore,
  type SecretStorage,
} from "#src/api/session.ts";

const headers = new Headers();
const ok = (body: unknown): ApiResult => ({ kind: "ok", status: 200, body, headers });
const PAIR = { access: "a-1", refresh: "r-1", expiresAt: 10 };
const ISSUED = { accessToken: "a-2", refreshToken: "r-2", expiresInSeconds: 60 };

function recordingStorage(initial: Record<string, string>, failGet = false) {
  const data = new Map(Object.entries(initial));
  const log: string[] = [];
  const storage: SecretStorage = {
    get: async (key) => {
      log.push(`get ${key}`);
      if (failGet) {
        throw new Error("could not decrypt");
      }
      return data.get(key) ?? null;
    },
    set: async (key, value) => {
      log.push(`set ${key}`);
      data.set(key, value);
    },
    delete: async (key) => {
      log.push(`delete ${key}`);
      data.delete(key);
    },
  };
  return { storage, data, log };
}

describe("createSessionStore", () => {
  it("deletes the session, then My QR, when the store cannot be read, and answers none", async () => {
    const { storage, log } = recordingStorage({}, true);
    expect(await createSessionStore(storage, () => 0).load()).toBeUndefined();
    expect(log).toEqual([`get ${SESSION_KEY}`, `delete ${SESSION_KEY}`, `delete ${MY_QR_KEY}`]);
  });

  it("answers none for an item it cannot parse, and deletes nothing", async () => {
    for (const raw of ["{", JSON.stringify({ access: "a" }), "null"]) {
      const { storage, log } = recordingStorage({ [SESSION_KEY]: raw });
      expect(await createSessionStore(storage, () => 0).load()).toBeUndefined();
      expect(log).toEqual([`get ${SESSION_KEY}`]);
    }
  });

  it("writes the pair as one item, ending its expiresInSeconds after now", async () => {
    const { storage, data, log } = recordingStorage({});
    await createSessionStore(storage, () => 1_000).save(ISSUED);
    expect(log).toEqual([`set ${SESSION_KEY}`]);
    expect(JSON.parse(data.get(SESSION_KEY) ?? "")).toEqual({
      access: "a-2",
      refresh: "r-2",
      expiresAt: 61_000,
    });
  });
});

function refresherWith(stored: boolean, answer: () => Promise<ApiResult>) {
  const { storage, data } = recordingStorage(stored ? { [SESSION_KEY]: JSON.stringify(PAIR) } : {});
  const calls: ApiRequest[] = [];
  const client: Client = {
    request: async (request) => {
      calls.push(request);
      return answer();
    },
  };
  const ends: number[] = [];
  const refresher = createRefresher({
    client,
    store: createSessionStore(storage, () => 0),
    end: async () => {
      ends.push(1);
    },
  });
  return { refresher, calls, data, ends };
}

describe("createRefresher", () => {
  it("gives two calls in the same tick one POST and the same promise", async () => {
    const { refresher, calls } = refresherWith(true, async () => ok(ISSUED));
    const first = refresher.refresh();
    const second = refresher.refresh();
    expect(second).toBe(first);
    expect(await first).toBe("refreshed");
    expect(calls).toHaveLength(1);
  });

  it("starts a new POST for a call after the last one settled", async () => {
    const { refresher, calls } = refresherWith(true, async () => ok(ISSUED));
    await refresher.refresh();
    await refresher.refresh();
    expect(calls).toHaveLength(2);
  });

  it("ends with no call when nothing is stored", async () => {
    const { refresher, calls, ends } = refresherWith(false, async () => ok(ISSUED));
    expect(await refresher.refresh()).toBe("ended");
    expect(calls).toEqual([]);
    expect(ends).toEqual([]);
  });

  it("settles quietly after a refresh that rejects, and at once with none in flight", async () => {
    const { refresher } = refresherWith(true, async () => {
      throw new Error("transport");
    });
    expect(await refresher.settled()).toBeUndefined();
    const failed = refresher.refresh();
    await expect(refresher.settled()).resolves.toBeUndefined();
    await expect(failed).rejects.toThrow("transport");
  });
});
