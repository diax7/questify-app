import { joinLink, parseJoinLink } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { fetchCard, playStoreLink, readCard } from "#src/lib/event-card.ts";

const CARD = {
  event: {
    id: "8d5b3c33-1f8e-4f3a-9a2e-0b1c2d3e4f50",
    joinCode: "ABC234",
    name: { ar: "ملتقى نجد", en: "Najd Meetup" },
    venue: { ar: null, en: "Hall 3" },
    kind: "physical",
    timezone: "Asia/Riyadh",
    startsAt: "2030-11-01T06:00:00.000Z",
    endsAt: "2030-11-01T14:00:00.000Z",
    statusNow: "scheduled",
    access: "private",
    joinMethods: ["code"],
  },
  card: {
    version: "0.1",
    title: { ar: "سيرى منظّم الفعالية", en: "The event's organizer will see" },
    receives: [{ ar: "اسم المستخدم والصورة الرمزية", en: "Your username and avatar" }],
  },
};

type Call = { url: string; init: RequestInit | undefined };

/** A fetch that answers once with this status, body and headers, and records what it was asked. */
function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const request = (
  code: string,
  fetchImpl: typeof fetch,
  forwardedFor: string | null = "203.0.113.9",
) => ({
  apiOrigin: "http://questify-api",
  code,
  forwardedFor,
  fetchImpl,
});

describe("fetchCard", () => {
  it("asks the API for the code with the visitor's address, and reads the card", async () => {
    const api = answering(200, CARD);
    expect(await fetchCard(request("ABC234", api.fetchImpl))).toEqual({
      kind: "found",
      event: CARD.event,
      card: { title: CARD.card.title, receives: CARD.card.receives },
    });
    expect(api.calls[0]?.url).toBe("http://questify-api/v1/public/events/ABC234");
    expect(new Headers(api.calls[0]?.init?.headers).get("x-forwarded-for")).toBe("203.0.113.9");
    expect(api.calls[0]?.init?.cache).toBe("no-store");
  });

  it("sends no forwarded header when the request had none", async () => {
    const api = answering(200, CARD);
    await fetchCard(request("ABC234", api.fetchImpl, null));
    expect(new Headers(api.calls[0]?.init?.headers).has("x-forwarded-for")).toBe(false);
  });

  it("asks nothing for a malformed code", async () => {
    const api = answering(200, CARD);
    for (const code of ["AB", "ABC-234", "ABCDEFGHJKMNP", "../x"]) {
      expect(await fetchCard(request(code, api.fetchImpl))).toEqual({ kind: "not_found" });
    }
    expect(api.calls).toEqual([]);
  });

  it("maps a 404, a 429 and every other failure", async () => {
    expect(
      await fetchCard(request("ABC234", answering(404, { code: "not_found" }).fetchImpl)),
    ).toEqual({
      kind: "not_found",
    });
    expect(await fetchCard(request("ABC234", answering(429, {}).fetchImpl))).toEqual({
      kind: "throttled",
    });
    for (const api of [
      answering(500, {}),
      answering(200, { event: {} }),
      answering(200, undefined),
    ]) {
      expect(await fetchCard(request("ABC234", api.fetchImpl))).toEqual({ kind: "unavailable" });
    }
    const failing = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    expect(await fetchCard(request("ABC234", failing))).toEqual({ kind: "unavailable" });
  });
});

describe("readCard", () => {
  it.each([
    ["no event", { card: CARD.card }],
    ["a name that is not text", { ...CARD, event: { ...CARD.event, name: "Najd" } }],
    ["an unknown status", { ...CARD, event: { ...CARD.event, statusNow: "draft" } }],
    ["an unknown access", { ...CARD, event: { ...CARD.event, access: "secret" } }],
    ["a missing time", { ...CARD, event: { ...CARD.event, startsAt: undefined } }],
    [
      "a card item missing a language",
      { ...CARD, card: { ...CARD.card, receives: [{ en: "x" }] } },
    ],
  ])("refuses an answer with %s", (_name, body) => {
    expect(readCard(body)).toBeUndefined();
  });
});

describe("the links", () => {
  it("adds the install referrer to the Play link, keeping its query", () => {
    const link = new URL(
      playStoreLink("https://play.google.com/store/apps/details?id=sa.questify", "abc234"),
    );
    expect(link.searchParams.get("id")).toBe("sa.questify");
    expect(link.searchParams.get("referrer")).toBe("join=ABC234");
  });

  it("copies a link the app's paste offer reads back (FR-114)", () => {
    for (const language of ["ar", "en"] as const) {
      expect(parseJoinLink(joinLink("ABC234", language))).toBe("ABC234");
    }
  });
});
