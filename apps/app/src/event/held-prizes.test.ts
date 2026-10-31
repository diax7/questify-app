import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import { fetchHeldPrizes, isCollecting, readHeldPrizes } from "#src/event/held-prizes.ts";

const headers = new Headers();
const NOW = Date.parse("2030-01-01T10:00:00Z");

const DESK = {
  location: { ar: "القاعة ب", en: "Hall B" },
  pin: null,
  hours: null,
  state: "open",
  confirm: "collect_first",
  timeZone: "Asia/Riyadh",
};

const PRIZE = {
  id: "d1",
  kind: "item",
  name: { ar: "هودي", en: "Hoodie" },
  reservedUntil: "2030-01-01T12:00:00.000Z",
  collectUntil: null,
  rank: null,
  source: "shop",
};

function sessionAnswering(answer: AuthedResult) {
  const calls: Omit<ApiRequest, "accessToken">[] = [];
  return {
    calls,
    session: {
      request: async (request: Omit<ApiRequest, "accessToken">) => {
        calls.push(request);
        return answer;
      },
    },
  };
}

describe("readHeldPrizes", () => {
  it("reads the desk and each prize, keeping the server's order", () => {
    const held = readHeldPrizes({
      desk: DESK,
      prizes: [PRIZE, { ...PRIZE, id: "d2", name: { ar: null, en: "Cap" }, source: "rank" }],
    });
    expect(held?.desk).toMatchObject({ confirm: "collect_first", state: "open" });
    expect(held?.prizes).toEqual([
      {
        id: "d1",
        name: { ar: "هودي", en: "Hoodie" },
        reservedUntil: "2030-01-01T12:00:00.000Z",
        collectUntil: null,
        source: "shop",
      },
      {
        id: "d2",
        name: { ar: null, en: "Cap" },
        reservedUntil: "2030-01-01T12:00:00.000Z",
        collectUntil: null,
        source: "rank",
      },
    ]);
  });

  it("leaves out a row without an id and shows an unknown source as the shop's", () => {
    const held = readHeldPrizes({
      desk: DESK,
      prizes: [{ name: { en: "No id" } }, null, "x", { ...PRIZE, source: "newer" }],
    });
    expect(held?.prizes.map((prize) => [prize.id, prize.source])).toEqual([["d1", "shop"]]);
  });

  it("answers nothing for a body that is not the answer", () => {
    expect(readHeldPrizes("<html>")).toBeUndefined();
    expect(readHeldPrizes(null)).toBeUndefined();
    expect(readHeldPrizes({ desk: DESK })).toBeUndefined();
    expect(readHeldPrizes({ desk: DESK, prizes: "no" })).toBeUndefined();
    expect(readHeldPrizes({ prizes: [PRIZE] })).toBeUndefined();
  });

  it("reads an empty list as nothing held", () => {
    expect(readHeldPrizes({ desk: DESK, prizes: [] })?.prizes).toEqual([]);
  });
});

describe("fetchHeldPrizes", () => {
  it("asks for the event's held prizes, not the shop", async () => {
    const ok = sessionAnswering({
      kind: "ok",
      status: 200,
      body: { desk: DESK, prizes: [PRIZE] },
      headers,
    });
    expect(await fetchHeldPrizes(ok.session, "e1")).toMatchObject({ kind: "held" });
    expect(ok.calls).toEqual([{ method: "GET", path: "/v1/events/e1/held-prizes" }]);
  });

  it("is unavailable for an error, a lost connection, an ended session and a broken body", async () => {
    const refused = sessionAnswering({
      kind: "error",
      status: 404,
      code: "not_found",
      message: { ar: "رسالة", en: "Message" },
      details: {},
      headers,
    });
    expect(await fetchHeldPrizes(refused.session, "e1")).toEqual({ kind: "unavailable" });
    for (const answer of [
      { kind: "network" },
      { kind: "signed_out" },
      { kind: "ok", status: 200, body: "<html>", headers },
    ] as const) {
      expect(await fetchHeldPrizes(sessionAnswering(answer).session, "e1")).toEqual({
        kind: "unavailable",
      });
    }
  });
});

describe("isCollecting", () => {
  const prize = {
    id: "d1",
    name: { ar: null, en: null },
    reservedUntil: null,
    source: "shop",
  } as const;

  it("is true only while the player's Collect has time left", () => {
    expect(isCollecting({ ...prize, collectUntil: "2030-01-01T10:00:01Z" }, NOW)).toBe(true);
    expect(isCollecting({ ...prize, collectUntil: "2030-01-01T10:00:00Z" }, NOW)).toBe(false);
    expect(isCollecting({ ...prize, collectUntil: "2030-01-01T09:00:00Z" }, NOW)).toBe(false);
    expect(isCollecting({ ...prize, collectUntil: null }, NOW)).toBe(false);
  });
});
