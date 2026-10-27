import { MARKETING_TEXT_VERSION } from "@questify/shared";
import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import {
  fetchCities,
  fetchForYou,
  fetchInterests,
  fetchMarketing,
  fetchPreferences,
  saveMarketing,
  savePreferences,
} from "#src/marketing/marketing-api.ts";

const ok = (body: unknown): AuthedResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});
const refused = (status: number, code: string): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details: {},
  headers: new Headers(),
});
const sessionOf = (...answers: AuthedResult[]) => {
  const request = vi.fn();
  for (const answer of answers) request.mockResolvedValueOnce(answer);
  return { request };
};

const state = { optedIn: false, changedAt: null };
const MARKETING = {
  channels: {
    push: state,
    sms: { optedIn: true, changedAt: "2030-01-01T00:00:00Z" },
    email: state,
  },
  asked: true,
  canOptIn: true,
};
const BODY = {
  textVersion: MARKETING_TEXT_VERSION,
  method: "settings",
  channels: { sms: true },
} as const;

describe("the reads", () => {
  it("read consent and preferences, and give null for an odd answer or a failure", async () => {
    expect(await fetchMarketing(sessionOf(ok(MARKETING)))).toEqual(MARKETING);
    expect(await fetchMarketing(sessionOf(ok({ asked: true })))).toBeNull();
    expect(await fetchMarketing(sessionOf({ kind: "network" }))).toBeNull();
    const prefs = { cityId: "sa-riyadh", interests: ["sport"] };
    expect(await fetchPreferences(sessionOf(ok(prefs)))).toEqual(prefs);
    expect(await fetchPreferences(sessionOf(ok({ cityId: 5, interests: [] })))).toBeNull();
  });

  it("read the lists by their paths", async () => {
    const sport = { id: "sport", name: { ar: "رياضة", en: "Sport" } };
    const riyadh = { id: "sa-riyadh", name: { ar: "الرياض", en: "Riyadh" } };
    const interests = sessionOf(ok({ interests: [sport] }));
    expect(await fetchInterests(interests)).toEqual([sport]);
    expect(interests.request).toHaveBeenCalledWith({ method: "GET", path: "/v1/interests" });
    expect(await fetchCities(sessionOf(ok({ cities: [riyadh] })))).toEqual([riyadh]);
    expect(await fetchInterests(sessionOf(ok({ interests: [{ id: "x" }] })))).toBeNull();
    expect(await fetchCities(sessionOf({ kind: "network" }))).toBeNull();
  });

  it("read For you, and never turn a failure into an empty list", async () => {
    expect(await fetchForYou(sessionOf(ok({ events: [] })))).toEqual([]);
    expect(await fetchForYou(sessionOf(refused(500, "server_error")))).toBeNull();
    expect(await fetchForYou(sessionOf(ok({ events: [{ id: "nope" }] })))).toBeNull();
  });
});

describe("saveMarketing", () => {
  it("sends the body and returns the state the server answers with", async () => {
    const session = sessionOf(ok(MARKETING));
    expect(await saveMarketing(session, BODY)).toEqual({ kind: "saved", marketing: MARKETING });
    expect(session.request).toHaveBeenCalledWith({
      method: "PUT",
      path: "/v1/me/marketing",
      body: BODY,
    });
  });

  it.each([
    ["the wording moved on", refused(409, "consent_text_outdated"), "outdated"],
    ["the account may not opt in", refused(403, "consent_age"), "age"],
    ["too many tries", refused(429, "too_many_attempts"), "limited"],
    ["any other refusal", refused(400, "invalid_request"), "failed"],
    ["a server fault", refused(500, "server_error"), "failed"],
    ["an odd answer", ok({ asked: true }), "failed"],
    ["a dropped connection", { kind: "network" } as AuthedResult, "network"],
    ["a session that ended", { kind: "signed_out" } as AuthedResult, "signed_out"],
  ])("answers %s as %s", async (_name, answer, kind) => {
    expect((await saveMarketing(sessionOf(answer), BODY)).kind).toBe(kind);
  });
});

describe("savePreferences", () => {
  const body = { cityId: "sa-riyadh", interests: ["sport"] };

  it("sends both fields and returns what the server kept", async () => {
    const session = sessionOf(ok(body));
    expect(await savePreferences(session, body)).toEqual({ kind: "saved", preferences: body });
    expect(session.request).toHaveBeenCalledWith({
      method: "PUT",
      path: "/v1/me/preferences",
      body,
    });
  });

  it.each([
    ["an unknown city or interest", refused(422, "invalid_preferences"), "invalid"],
    ["too many tries", refused(429, "too_many_attempts"), "limited"],
    ["any other refusal", refused(400, "invalid_request"), "failed"],
    ["an odd answer", ok({ cityId: 1 }), "failed"],
    ["a dropped connection", { kind: "network" } as AuthedResult, "network"],
    ["a session that ended", { kind: "signed_out" } as AuthedResult, "signed_out"],
  ])("answers %s as %s", async (_name, answer, kind) => {
    expect((await savePreferences(sessionOf(answer), body)).kind).toBe(kind);
  });
});
