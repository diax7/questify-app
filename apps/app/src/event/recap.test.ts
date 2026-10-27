import {
  DEFAULT_TERMS,
  MESSAGES,
  createTranslator,
  type EventRecap,
  type Language,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { fetchRecap, recapAnswer } from "#src/event/recap-api.ts";
import type { Home } from "#src/event/home-api.ts";
import { SOUVENIRS_ON_CARD, recapOffered, recapShareText, recapView } from "#src/event/recap.ts";
import { withWords } from "#src/i18n/words.ts";

const translate = createTranslator(MESSAGES);
const tIn = (language: Language) =>
  withWords((key, params) => translate(key, language, params), DEFAULT_TERMS, language);

const EVENT_ID = "3f8c1d7e-2b4a-4c9d-8e1f-0a5b6c7d8e9f";

const souvenir = (n: number) => ({
  id: `item-${n}`,
  kind: "frame" as const,
  name: { ar: `إطار ${n}`, en: `Frame ${n}` },
  visualKey: "frame-01",
});

const RECAP: EventRecap = {
  event: {
    id: EVENT_ID,
    name: { ar: "ملتقى نجد", en: "Najd Meetup" },
    date: "2030-11-01",
    city: { ar: "الرياض", en: "Riyadh" },
  },
  rank: { state: "final", value: 3 },
  questsDone: 7,
  souvenirs: [souvenir(1)],
};

describe("recapView", () => {
  it("writes the card in English: name, date and city, rank, quests, souvenirs", () => {
    expect(recapView(RECAP, "en", tIn("en"))).toEqual({
      title: "Najd Meetup",
      emblem: "N",
      where: "1 Nov 2030 · Riyadh",
      rank: { kind: "final", text: "Rank 3" },
      quests: "Quests done: 7",
      souvenirs: { heading: "Your souvenirs", names: ["Frame 1"], more: null },
      summary: "Najd Meetup. 1 Nov 2030, Riyadh. Rank 3. Quests done: 7. Your souvenirs Frame 1",
    });
  });

  it("writes it in Arabic with Western digits and the event's own quest word", () => {
    const view = recapView(RECAP, "ar", tIn("ar"));
    expect(view.title).toBe("ملتقى نجد");
    expect(view.emblem).toBe("م");
    expect(view.where).toMatch(/^1 نوفمبر 2030 · الرياض$/);
    expect(view.rank).toEqual({ kind: "final", text: "المركز 3" });
    expect(view.quests).toBe("ما أنجزته من مهام: 7");
    expect(view.souvenirs).toEqual({ heading: "تذكاراتك", names: ["إطار 1"], more: null });
    expect(`${view.where}${view.rank?.text}${view.quests}`).not.toMatch(/[٠-٩]/);
  });

  it("says the final rank comes with the results while the results are not revealed", () => {
    const pending = { ...RECAP, rank: { state: "pending" as const, value: null } };
    expect(recapView(pending, "en", tIn("en")).rank).toEqual({
      kind: "pending",
      text: "Your final rank comes with the results",
    });
    expect(recapView(pending, "ar", tIn("ar")).rank).toEqual({
      kind: "pending",
      text: "يظهر ترتيبك النهائي مع إعلان النتائج",
    });
  });

  it("leaves the rank line out for a member with no place", () => {
    const unranked = { ...RECAP, rank: { state: "unranked" as const, value: null } };
    const view = recapView(unranked, "en", tIn("en"));
    expect(view.rank).toBeNull();
    expect(view.summary).not.toContain("Rank");
  });

  it("thanks a member who did no quest instead of counting zero", () => {
    const none = { ...RECAP, questsDone: 0 };
    expect(recapView(none, "en", tIn("en")).quests).toBe("Thanks for joining");
    expect(recapView(none, "ar", tIn("ar")).quests).toBe("شكرًا لمشاركتك");
  });

  it("leaves the souvenir part out when the event gave none", () => {
    const view = recapView({ ...RECAP, souvenirs: [] }, "en", tIn("en"));
    expect(view.souvenirs).toBeNull();
    expect(view.summary).not.toContain("souvenir");
  });

  it("names three souvenirs and counts the rest", () => {
    const four = { ...RECAP, souvenirs: [1, 2, 3, 4].map(souvenir) };
    expect(SOUVENIRS_ON_CARD).toBe(3);
    const english = recapView(four, "en", tIn("en")).souvenirs;
    expect(english?.names).toEqual(["Frame 1", "Frame 2", "Frame 3"]);
    expect(english?.more).toBe("‎+1");
    const nine = { ...RECAP, souvenirs: Array.from({ length: 12 }, (_, i) => souvenir(i + 1)) };
    expect(recapView(nine, "ar", tIn("ar")).souvenirs).toMatchObject({
      names: ["إطار 1", "إطار 2", "إطار 3"],
      more: "‎+9",
    });
    const exactly = { ...RECAP, souvenirs: [1, 2, 3].map(souvenir) };
    expect(recapView(exactly, "en", tIn("en")).souvenirs?.more).toBeNull();
  });

  it("drops the city when the event has none", () => {
    const view = recapView({ ...RECAP, event: { ...RECAP.event, city: null } }, "en", tIn("en"));
    expect(view.where).toBe("1 Nov 2030");
    expect(view.summary.startsWith("Najd Meetup. 1 Nov 2030. Rank 3")).toBe(true);
  });

  it("shows nothing about the player beyond what the schema carries", () => {
    const text = JSON.stringify(recapView(RECAP, "en", tIn("en")));
    expect(text).not.toMatch(/username|score|balance|http|@/i);
  });
});

describe("recapShareText", () => {
  it("is one fixed line naming the event, with no link", () => {
    expect(recapShareText(RECAP, "en", tIn("en"))).toBe("My recap from Najd Meetup");
    expect(recapShareText(RECAP, "ar", tIn("ar"))).toBe("ملخّصي في ملتقى نجد");
  });
});

const home = (statusNow: string, standing: Home["standing"], rehearsal = false) => ({
  event: { statusNow, rehearsal } as Home["event"],
  standing,
});

describe("recapOffered", () => {
  const active = {
    status: "active",
    score: 1,
    balance: 1,
    pendingPoints: 0,
    questsDone: 1,
    questsTotal: 2,
  } as const;

  it("is offered to an active member once the event ended or was archived", () => {
    expect(recapOffered(home("ended", active))).toBe(true);
    expect(recapOffered(home("archived", active))).toBe(true);
  });

  it("is not offered before the end", () => {
    for (const status of ["draft", "scheduled", "live"]) {
      expect(recapOffered(home(status, active))).toBe(false);
    }
  });

  it("is not offered to a member who is waiting or was declined", () => {
    expect(recapOffered(home("ended", { status: "pending", waitlisted: false }))).toBe(false);
    expect(recapOffered(home("ended", { status: "declined" }))).toBe(false);
  });

  it("is not offered to a rehearsal account", () => {
    expect(recapOffered(home("ended", active, true))).toBe(false);
  });
});

const headers = new Headers();
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const refused = (status: number, code: string): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details: {},
  headers,
});

describe("recapAnswer", () => {
  it("reads the recap", () => {
    expect(recapAnswer(ok(RECAP))).toEqual({ kind: "recap", recap: RECAP });
  });

  it("reads a pending and an unranked rank", () => {
    const pending = { ...RECAP, rank: { state: "pending", value: null } };
    expect(recapAnswer(ok(pending))).toEqual({ kind: "recap", recap: pending });
    const unranked = { ...RECAP, rank: { state: "unranked", value: null } };
    expect(recapAnswer(ok(unranked))).toEqual({ kind: "recap", recap: unranked });
  });

  it("reads a 404 as gone and a 409 not_ended as not ended", () => {
    expect(recapAnswer(refused(404, "not_found"))).toEqual({ kind: "gone" });
    expect(recapAnswer(refused(409, "not_ended"))).toEqual({ kind: "not_ended" });
  });

  it("reads any other refusal, and an answer of another shape, as a failure to load", () => {
    expect(recapAnswer(refused(409, "something_else"))).toEqual({ kind: "network" });
    expect(recapAnswer(refused(500, "internal"))).toEqual({ kind: "network" });
    expect(recapAnswer(refused(429, "too_many_attempts"))).toEqual({ kind: "network" });
    expect(recapAnswer(ok({ ...RECAP, questsDone: -1 }))).toEqual({ kind: "network" });
    expect(recapAnswer(ok({ ...RECAP, rank: { state: "final", value: null } }))).toEqual({
      kind: "network",
    });
    expect(recapAnswer(ok("<html>"))).toEqual({ kind: "network" });
  });

  it("passes a lost connection and a signed-out session through", () => {
    expect(recapAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(recapAnswer({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
  });
});

describe("fetchRecap", () => {
  it("asks the event's recap route", async () => {
    const calls: unknown[] = [];
    const session = {
      request: async (request: unknown) => {
        calls.push(request);
        return ok(RECAP);
      },
    };
    expect(await fetchRecap(session, EVENT_ID)).toEqual({ kind: "recap", recap: RECAP });
    expect(calls).toEqual([{ method: "GET", path: `/v1/events/${EVENT_ID}/recap` }]);
  });
});
