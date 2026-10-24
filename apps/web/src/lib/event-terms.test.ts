import { DEFAULT_TERMS } from "@questify/shared";
import { describe, expect, it, vi } from "vitest";
import { fetchEventTerms, type EventTermsRequest } from "#src/lib/event-terms.ts";

const MISSION = {
  quest: { ar: { one: "مغامرة", many: "مغامرات" }, en: { one: "mission", many: "missions" } },
};

type Call = { url: string; init: RequestInit | undefined };

function answering(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const request = (overrides: Partial<EventTermsRequest>): EventTermsRequest => ({
  apiOrigin: "http://api",
  organizerId: "org-1",
  eventId: "event-1",
  sessionToken: "session-token",
  forwardedFor: null,
  ...overrides,
});

describe("fetchEventTerms", () => {
  it("reads the event's words with the staff session", async () => {
    const { calls, fetchImpl } = answering(200, { event: { terms: MISSION } });
    const terms = await fetchEventTerms(request({ fetchImpl, forwardedFor: "203.0.113.9" }));
    expect(terms.quest.en.one).toBe("mission");
    expect(terms.category).toEqual(DEFAULT_TERMS.category);
    expect(calls[0]?.url).toBe("http://api/v1/organizers/org-1/events/event-1");
    const headers = calls[0]?.init?.headers as Headers;
    expect(headers.get("cookie")).toBe("__Host-qs_session=session-token");
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.9");
  });

  it("keeps Questify's words when the event has none saved", async () => {
    const { fetchImpl } = answering(200, { event: {} });
    expect(await fetchEventTerms(request({ fetchImpl }))).toEqual(DEFAULT_TERMS);
  });

  it("keeps Questify's words without a session, without asking the API", async () => {
    const { calls, fetchImpl } = answering(200, { event: { terms: MISSION } });
    expect(await fetchEventTerms(request({ fetchImpl, sessionToken: undefined }))).toEqual(
      DEFAULT_TERMS,
    );
    expect(await fetchEventTerms(request({ fetchImpl, sessionToken: "" }))).toEqual(DEFAULT_TERMS);
    expect(calls).toEqual([]);
  });

  it("keeps Questify's words when the event is out of reach or the API answers badly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await fetchEventTerms(request({ fetchImpl: answering(404, {}).fetchImpl }))).toEqual(
      DEFAULT_TERMS,
    );
    expect(
      await fetchEventTerms(request({ fetchImpl: answering(200, undefined).fetchImpl })),
    ).toEqual(DEFAULT_TERMS);
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await fetchEventTerms(request({ fetchImpl: failing }))).toEqual(DEFAULT_TERMS);
    expect(warn).toHaveBeenCalledWith("event words not read: event event-1 answered 404");
    expect(warn).toHaveBeenCalledWith("event words not read: event event-1 could not be reached");
    warn.mockRestore();
  });

  it("escapes the ids it puts in the path", async () => {
    const { calls, fetchImpl } = answering(404, {});
    await fetchEventTerms(request({ fetchImpl, eventId: "../x?y" }));
    expect(calls[0]?.url).toBe("http://api/v1/organizers/org-1/events/..%2Fx%3Fy");
  });
});
