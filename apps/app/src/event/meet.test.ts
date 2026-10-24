import { MESSAGES, createTranslator, type Language, type MessageKey } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import {
  MEET_POLL,
  isMeetCode,
  meetRefusalText,
  metAnswerOf,
  nextPoll,
  passAnswerOf,
  passStateOf,
  scanMeet,
} from "#src/event/meet.ts";
import type { MeetReason } from "#src/event/quests-api.ts";

const translate = createTranslator(MESSAGES);
const tIn =
  (language: Language) => (key: MessageKey, values?: Readonly<Record<string, string | number>>) =>
    translate(key, language, values);
const headers = new Headers();
const ok = (body: unknown, status = 200): AuthedResult => ({ kind: "ok", status, body, headers });
const refused = (status: number, code: string, details: Record<string, unknown>): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details,
  headers,
});
const refusal = (
  reason: MeetReason | undefined,
  name: string | null = null,
  cap: number | null = null,
) => ({ kind: "meet_refused", reason, name, cap }) as const;

describe("meet refusals", () => {
  it("says every reason in both languages, with the name and the cap", () => {
    for (const language of ["ar", "en"] as const) {
      const t = tIn(language);
      expect(meetRefusalText(refusal("already_met", "noura"), t)).toContain("@noura");
      expect(meetRefusalText(refusal("daily_cap", null, 5), t)).toContain("5");
      for (const reason of [
        "their_daily_cap",
        "done",
        "their_done",
        "expired",
        "used",
        "self",
        "same_device",
        "not_in_event",
        "not_for_them",
        "bad_code",
        "off",
      ] as const) {
        expect(meetRefusalText(refusal(reason), t), reason).not.toBe("");
      }
    }
    const t = tIn("en");
    expect(meetRefusalText(refusal("expired"), t)).toBe(meetRefusalText(refusal("used"), t));
    expect(meetRefusalText(refusal("their_daily_cap"), t)).toBe(
      "They've reached today's limit. Try again tomorrow.",
    );
    expect(meetRefusalText(refusal("their_daily_cap"), tIn("ar"))).toBe(
      "بلغ هذا اللاعب حد اليوم. حاول مجددًا غدًا.",
    );
    expect(meetRefusalText(refusal(undefined), t)).toBe(t("questsTab.failed"));
  });

  it("reads a refusal's reason, name and cap, and an unknown reason as undefined", () => {
    expect(
      metAnswerOf(refused(409, "meet_refused", { reason: "already_met", name: "noura" })),
    ).toEqual(refusal("already_met", "noura"));
    expect(metAnswerOf(refused(409, "meet_refused", { reason: "daily_cap", cap: 3 }))).toEqual(
      refusal("daily_cap", null, 3),
    );
    expect(metAnswerOf(refused(422, "meet_refused", { reason: "new_one" }))).toEqual(
      refusal(undefined),
    );
    expect(metAnswerOf(refused(403, "feature_off", {}))).toEqual(refusal("off"));
    expect(metAnswerOf({ kind: "network" })).toEqual({ kind: "network" });
  });
});

describe("meet answers", () => {
  it("reads a paid meeting with its quest and whom the player met", () => {
    expect(
      metAnswerOf(
        ok({
          points: 50,
          score: 50,
          replayed: false,
          levelUp: null,
          bonus: null,
          item: null,
          questId: "q1",
          met: { username: "noura", avatar: "owl" },
        }),
      ),
    ).toEqual({
      kind: "completed",
      points: 50,
      score: 50,
      replayed: false,
      levelUp: null,
      bonus: null,
      item: null,
      boost: null,
      questId: "q1",
      met: { username: "noura", avatar: "owl" },
    });
    expect(metAnswerOf(ok({ points: 5, score: 5, met: { username: 1 } }))).not.toHaveProperty(
      "met",
    );
  });

  it("sends the whole code in the body with the key, and the position only when there is one", async () => {
    const sent: unknown[] = [];
    const session = {
      request: async (request: unknown) => {
        sent.push(request);
        return { kind: "network" } as const;
      },
    };
    await scanMeet(session, "questify/meet/v1/x", "k1", null);
    await scanMeet(session, "questify/meet/v1/x", "k2", { lat: 1, lng: 2, accuracyM: 5, ageS: 1 });
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/meet",
        body: { code: "questify/meet/v1/x" },
        headers: { "idempotency-key": "k1" },
      },
      {
        method: "POST",
        path: "/v1/meet",
        body: {
          code: "questify/meet/v1/x",
          position: { lat: 1, lng: 2, accuracyM: 5, ageS: 1 },
        },
        headers: { "idempotency-key": "k2" },
      },
    ]);
  });

  it("tells a meet code from anything else", () => {
    expect(isMeetCode("questify/meet/v1/abc")).toBe(true);
    expect(isMeetCode("https://questify.nafes.com/q/abc")).toBe(false);
  });
});

describe("the shown code", () => {
  it("reads a pass, or why there is none", () => {
    expect(
      passAnswerOf(
        ok({ code: "questify/meet/v1/x", passId: "7", expiresAt: "2030-01-01T00:00:00Z" }, 201),
      ),
    ).toEqual({
      kind: "pass",
      code: "questify/meet/v1/x",
      passId: "7",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(passAnswerOf(ok({ code: 1 }))).toEqual({ kind: "failed" });
    expect(passAnswerOf(refused(409, "meet_refused", { reason: "daily_cap", cap: 2 }))).toEqual(
      refusal("daily_cap", null, 2),
    );
    expect(passAnswerOf(refused(409, "already_completed", {}))).toEqual({ kind: "limit" });
    expect(passAnswerOf(refused(403, "feature_off", {}))).toEqual(refusal("off"));
  });

  it("reads its state: open, expired, used with the scanner, slow after a 429", () => {
    expect(passStateOf(ok({ state: "open", met: null }))).toEqual({ state: "open" });
    expect(passStateOf(ok({ state: "expired", met: null }))).toEqual({ state: "expired" });
    expect(
      passStateOf(ok({ state: "used", met: { username: "sara", avatar: "fox", points: 50 } })),
    ).toEqual({ state: "used", username: "sara", points: 50 });
    expect(passStateOf(ok({ state: "used", met: null }))).toEqual({ state: "unknown" });
    expect(passStateOf(refused(429, "too_many_attempts", {}))).toEqual({ state: "slow" });
    expect(passStateOf({ kind: "network" })).toEqual({ state: "unknown" });
  });

  it("polls every 2 seconds, every 5 after a 429, and stops when used, expired or past its minute", () => {
    expect(nextPoll({ state: "open" }, 0, 1000)).toBe(MEET_POLL.everyMs);
    expect(nextPoll({ state: "unknown" }, 0, 1000)).toBe(2000);
    expect(nextPoll({ state: "slow" }, 0, 1000)).toBe(5000);
    expect(nextPoll({ state: "expired" }, 0, 1000)).toBeNull();
    expect(nextPoll({ state: "used", username: "a", points: 1 }, 0, 1000)).toBeNull();
    expect(nextPoll({ state: "open" }, 0, 59_999)).toBe(2000);
    expect(nextPoll({ state: "open" }, 0, 60_000)).toBeNull();
  });
});
