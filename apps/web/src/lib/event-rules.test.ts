import { describe, expect, it, vi } from "vitest";
import { fetchRules, organizerTextIn, readRules } from "#src/lib/event-rules.ts";

const RULES = {
  block: { ar: ["سطر"], en: ["A line"] },
  text: { ar: null, en: "Bring your ID." },
};

const answering = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const request = (fetchImpl: typeof fetch, code = "NAJD1") => ({
  apiOrigin: "https://api.test",
  code,
  forwardedFor: "1.2.3.4",
  fetchImpl,
});

const as = (fetchImpl: unknown) => fetchRules(request(fetchImpl as typeof fetch));

describe("event rules", () => {
  it("reads a rules answer and refuses anything else", () => {
    expect(readRules({ rules: RULES })).toEqual(RULES);
    expect(readRules({ rules: { block: null, text: { ar: "x", en: null } } })).toBeDefined();
    expect(readRules({ rules: { block: { ar: [1], en: [] }, text: RULES.text } })).toBeUndefined();
    expect(readRules({ rules: { block: null, text: null } })).toBeUndefined();
    expect(readRules({ rules: { block: null, text: { ar: 1, en: null } } })).toBeUndefined();
    expect(readRules({ rules: null })).toBeUndefined();
    expect(readRules(null)).toBeUndefined();
  });

  it("asks the API by code with the visitor's address, never for a malformed code", async () => {
    const fetchImpl = answering(200, { rules: RULES });
    expect(await fetchRules(request(fetchImpl as unknown as typeof fetch))).toEqual({
      kind: "found",
      rules: RULES,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/public/events/NAJD1/rules");
    expect(new Headers(init.headers).get("x-forwarded-for")).toBe("1.2.3.4");
    const never = vi.fn();
    expect(await fetchRules(request(never as unknown as typeof fetch, "../x"))).toEqual({
      kind: "not_found",
    });
    expect(never).not.toHaveBeenCalled();
  });

  it("answers not found, throttled and unavailable", async () => {
    expect(await as(answering(404, {}))).toEqual({ kind: "not_found" });
    expect(await as(answering(429, {}))).toEqual({ kind: "throttled" });
    expect(await as(answering(500, {}))).toEqual({ kind: "unavailable" });
    expect(await as(answering(200, { nope: true }))).toEqual({ kind: "unavailable" });
    expect(await as(vi.fn(async () => Promise.reject(new Error("down"))))).toEqual({
      kind: "unavailable",
    });
  });

  it("picks the organizer's text in the page's language, else the other", () => {
    expect(organizerTextIn(RULES, "en")).toBe("Bring your ID.");
    expect(organizerTextIn(RULES, "ar")).toBe("Bring your ID.");
    expect(organizerTextIn({ ...RULES, text: { ar: "اقرأ", en: null } }, "ar")).toBe("اقرأ");
    expect(organizerTextIn({ ...RULES, text: { ar: null, en: null } }, "ar")).toBeNull();
  });
});
