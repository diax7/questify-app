import { describe, expect, it } from "vitest";
import {
  BLANK_REQUEST,
  countText,
  eventRefusalText,
  invitationsOpen,
  invitationProblemText,
  invitationsPath,
  readCampaign,
  readCampaigns,
  requestBodyOf,
  riyadhTime,
  sessionLost,
  wholeNumber,
} from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";

const en = translatorFor("en");
const ar = translatorFor("ar");

const campaign = {
  id: "44444444-4444-4444-8444-444444444444",
  state: "sending",
  endReason: null,
  cityId: "sa-jeddah",
  interests: ["tech"],
  history: "recent",
  size: 500,
  sendAfter: null,
  cap: 400,
  sendAt: "2026-10-28T09:00:00+00:00",
  note: null,
  requestedAt: "2026-10-27T09:00:00+00:00",
  decidedAt: "2026-10-27T10:00:00+00:00",
  startedAt: "2026-10-28T09:00:05+00:00",
  finishedAt: null,
  publishedAt: null,
  counts: { sent: { atLeast: 390 }, opened: { fewerThan: 10 }, joined: null },
};

const refusal = (code: string, details: object) => ({
  code,
  message: { ar: "رسالة الخادم", en: "Server message" },
  details,
});

describe("readCampaigns", () => {
  it("reads the switch and the requests as the API sends them", () => {
    expect(readCampaigns({ enabled: true, campaigns: [campaign] })?.campaigns[0]?.state).toBe(
      "sending",
    );
    expect(readCampaigns({ enabled: false, campaigns: [] })).toEqual({
      enabled: false,
      campaigns: [],
    });
  });

  it.each([
    ["no body", undefined],
    ["no switch", { campaigns: [] }],
    [
      "an exact count, which an organizer never gets",
      {
        enabled: true,
        campaigns: [{ ...campaign, counts: { ...campaign.counts, sent: 391 } }],
      },
    ],
    ["a player", { enabled: true, campaigns: [{ ...campaign, players: ["a"] }] }],
  ])("refuses %s", (_name, body) => {
    expect(readCampaigns(body)).toBeUndefined();
  });
});

describe("readCampaign", () => {
  it("reads the request a new request answers with", () => {
    expect(readCampaign({ campaign })?.id).toBe(campaign.id);
  });

  it("refuses an answer without the key or with the wrong shape", () => {
    expect(readCampaign(campaign)).toBeUndefined();
    expect(readCampaign({ campaign: { ...campaign, size: "x" } })).toBeUndefined();
    expect(readCampaign(undefined)).toBeUndefined();
  });
});

describe("invitationsPath", () => {
  it("is the event's route", () => {
    expect(invitationsPath("o1", "e1")).toBe("/v1/organizers/o1/events/e1/invitation-campaigns");
  });
});

describe("invitationsOpen", () => {
  it("links to the page only when the list was read and the switch is on", () => {
    expect(invitationsOpen({ ok: true, status: 200, body: { enabled: true, campaigns: [] } })).toBe(
      true,
    );
    expect(
      invitationsOpen({ ok: true, status: 200, body: { enabled: false, campaigns: [] } }),
    ).toBe(false);
  });

  it("hides the link when the list could not be read", () => {
    expect(invitationsOpen({ ok: false, status: 404, body: undefined })).toBe(false);
    expect(invitationsOpen({ ok: false, status: 0, body: undefined })).toBe(false);
    expect(invitationsOpen({ ok: true, status: 200, body: { enabled: true } })).toBe(false);
    expect(invitationsOpen({ ok: true, status: 200, body: undefined })).toBe(false);
  });
});

describe("sessionLost", () => {
  it.each(["unauthenticated", "session_expired"])("is true for %s", (code) => {
    expect(sessionLost({ code })).toBe(true);
  });

  it("is false for other answers and for no answer", () => {
    expect(sessionLost({ code: "owner_only" })).toBe(false);
    expect(sessionLost(undefined)).toBe(false);
  });
});

describe("countText", () => {
  it("says fewer than 10, the rounded floor with a plus, or that nothing is published yet", () => {
    expect(countText({ fewerThan: 10 }, "en", en)).toBe("Fewer than 10");
    expect(countText({ atLeast: 120 }, "en", en)).toBe("120+");
    expect(countText({ atLeast: 1200 }, "en", en)).toBe("1,200+");
    expect(countText(null, "en", en)).toBe("Not published yet");
  });

  it("uses Western digits in Arabic", () => {
    expect(countText({ fewerThan: 10 }, "ar", ar)).toBe("أقل من 10");
    expect(countText({ atLeast: 120 }, "ar", ar)).toBe("120 أو أكثر");
  });
});

describe("a request's size and cap in words", () => {
  it("groups thousands and keeps Western digits in both languages", () => {
    expect(en("invCampaign.card.size", { count: 100_000 })).toBe("Invitations asked for: 100,000");
    expect(ar("invCampaign.card.size", { count: 100_000 })).toBe("عدد الدعوات المطلوب: 100,000");
    expect(en("invCampaign.card.approved", { count: 1200, time: "T" })).toContain("1,200 messages");
  });
});

describe("wholeNumber", () => {
  it.each([
    ["50", 50],
    [" 100000 ", 100_000],
    ["0", 0],
  ])("reads %j as %d", (text, number) => {
    expect(wholeNumber(text)).toBe(number);
  });

  it.each(["", "5.5", "-3", "1e3", "abc", "12345678", "٥٠"])("refuses %j", (text) => {
    expect(wholeNumber(text)).toBeNaN();
  });
});

describe("requestBodyOf", () => {
  const draft = { ...BLANK_REQUEST, size: "50" };

  it("builds the smallest request: only a size, everything else empty", () => {
    expect(requestBodyOf(draft)).toEqual({
      body: { cityId: null, interests: [], history: "none", size: 50, sendAfter: null },
    });
  });

  it("carries the criteria and reads the earliest send as Riyadh time", () => {
    const made = requestBodyOf({
      cityId: "sa-riyadh",
      interests: ["tech", "music"],
      history: "own",
      size: "1200",
      sendAfter: "2026-11-02T10:30",
    });
    expect(made).toEqual({
      body: {
        cityId: "sa-riyadh",
        interests: ["tech", "music"],
        history: "own",
        size: 1200,
        sendAfter: "2026-11-02T07:30:00.000Z",
      },
    });
  });

  it.each(["", "49", "100001", "50.5", "five"])("refuses the size %j", (size) => {
    expect(requestBodyOf({ ...draft, size })).toEqual({ problem: "size" });
  });

  it("accepts both ends of the size range", () => {
    expect(requestBodyOf({ ...draft, size: "100000" })).toHaveProperty("body.size", 100_000);
  });

  it("refuses a send time that is not a date", () => {
    expect(requestBodyOf({ ...draft, sendAfter: "next week" })).toEqual({ problem: "sendAfter" });
    expect(requestBodyOf({ ...draft, sendAfter: "2026-02-30T10:00" })).toEqual({
      problem: "sendAfter",
    });
  });
});

describe("eventRefusalText", () => {
  it.each([
    ["not_public", "Only events that everyone can find"],
    ["not_running", "scheduled or live"],
    ["ends_soon", "at least 24 hours"],
    ["link_off", "joining by link"],
    ["guest_list_only", "guest list only"],
    ["email_domains", "email from certain domains"],
  ])("explains the event reason %s in English", (reason, words) => {
    expect(eventRefusalText(refusal("event_not_eligible", { reason }), en)).toContain(words);
  });

  it("explains it in Arabic too", () => {
    expect(eventRefusalText(refusal("event_not_eligible", { reason: "ends_soon" }), ar)).toContain(
      "24 ساعة",
    );
  });

  it("names the language and the reason of a name the SMS cannot carry", () => {
    expect(
      eventRefusalText(refusal("event_name", { language: "ar", reason: "looks_like_phone" }), en),
    ).toBe("The event's Arabic name can't go in a text message: it looks like a phone number.");
    expect(
      eventRefusalText(refusal("event_name", { language: "en", reason: "looks_like_address" }), ar),
    ).toContain("الإنجليزي");
  });

  it("says nothing about other answers or an unknown reason", () => {
    expect(eventRefusalText(refusal("owner_only", {}), en)).toBeUndefined();
    expect(eventRefusalText(refusal("event_not_eligible", { reason: "x" }), en)).toBeUndefined();
    expect(
      eventRefusalText(refusal("event_name", { language: "fr", reason: "looks_like_phone" }), en),
    ).toBeUndefined();
    expect(eventRefusalText(undefined, en)).toBeUndefined();
  });
});

describe("invitationProblemText", () => {
  it("adds what to do after a refused name", () => {
    const text = invitationProblemText(
      refusal("event_name", { language: "en", reason: "control_characters" }),
      "en",
      en,
    );
    expect(text).toBe(
      "The event's English name can't go in a text message: it has hidden characters. Change the name, then ask again.",
    );
  });

  it("uses the API's own message for every other refusal, in the page's language", () => {
    expect(invitationProblemText(refusal("owner_only", {}), "en", en)).toBe("Server message");
    expect(invitationProblemText(refusal("owner_only", {}), "ar", ar)).toBe("رسالة الخادم");
  });

  it("says the connection failed when there is no answer", () => {
    expect(invitationProblemText(undefined, "en", en)).toBe(en("error.network"));
  });
});

describe("riyadhTime", () => {
  it("names the zone and keeps Western digits", () => {
    expect(riyadhTime("2026-10-28T06:00:00Z", "en")).toContain("09:00");
    expect(riyadhTime("2026-10-28T06:00:00Z", "en")).toContain("Riyadh time");
    expect(riyadhTime("2026-10-28T06:00:00Z", "ar")).toContain("بتوقيت الرياض");
    expect(riyadhTime("2026-10-28T06:00:00Z", "ar")).toMatch(/09:00/);
  });
});
