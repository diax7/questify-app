import { describe, expect, it } from "vitest";
import { MESSAGES, type AdminCampaign, type AdminQuest } from "@questify/shared";
import {
  BLANK_CAMPAIGN,
  BLANK_QUEST,
  campaignBodyOf,
  campaignDraftOf,
  invalidKey,
  questBodyOf,
  questCanPay,
  questDraftOf,
  questPatchOf,
  readAdminQuestify,
  refusalKey,
  saudiStamp,
} from "#src/lib/console-questify.ts";

const CAMPAIGN_ID = "6f1c7a0e-0000-4000-8000-000000000001";
const QUEST_ID = "6f1c7a0e-0000-4000-8000-000000000002";
const campaignDraft = {
  nameAr: "موسم الشتاء",
  nameEn: "Winter season",
  startsAt: "2026-12-01T09:00",
  endsAt: "2026-12-31T21:30",
};
const questDraft = {
  ...BLANK_QUEST,
  titleAr: "شارك في 3 فعاليات",
  titleEn: "Attend 3 events",
  target: "3",
  xp: "300",
};

describe("campaignBodyOf", () => {
  it("sends the window in Saudi time with its +03:00 offset", () => {
    expect(campaignBodyOf(campaignDraft)).toEqual({
      ok: true,
      body: {
        name: { ar: "موسم الشتاء", en: "Winter season" },
        startsAt: "2026-12-01T09:00:00+03:00",
        endsAt: "2026-12-31T21:30:00+03:00",
      },
    });
  });

  it.each([
    ["a missing Arabic name", { nameAr: "  " }, "label"],
    ["a name past 80 characters", { nameEn: "x".repeat(81) }, "label"],
    ["a name with a direction-override character", { nameEn: "Win‮ter" }, "label"],
    ["no start", { startsAt: "" }, "startsAt"],
    ["no end", { endsAt: "" }, "endsAt"],
  ] as const)("refuses %s before sending", (_name, patch, field) => {
    expect(campaignBodyOf({ ...campaignDraft, ...patch })).toEqual({ ok: false, field });
  });

  it("refuses a window that ends when or before it starts", () => {
    expect(campaignBodyOf({ ...campaignDraft, endsAt: campaignDraft.startsAt })).toEqual({
      ok: false,
      field: "endsAt",
    });
    expect(campaignBodyOf({ ...campaignDraft, endsAt: "2026-11-30T09:00" })).toEqual({
      ok: false,
      field: "endsAt",
    });
  });

  it("trims names", () => {
    const checked = campaignBodyOf({ ...campaignDraft, nameEn: "  Winter  " });
    expect(checked.ok && checked.body.name.en).toBe("Winter");
  });
});

describe("campaignDraftOf", () => {
  const campaign: AdminCampaign = {
    id: CAMPAIGN_ID,
    name: { ar: "موسم", en: "Season" },
    startsAt: "2026-12-01T06:00:00.000Z",
    endsAt: "2026-12-31T18:30:00.000Z",
    status: "draft",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };

  it("shows the instants as the Saudi wall clock", () => {
    expect(campaignDraftOf(campaign)).toEqual({
      nameAr: "موسم",
      nameEn: "Season",
      startsAt: "2026-12-01T09:00",
      endsAt: "2026-12-31T21:30",
    });
  });

  it("round-trips through the body the API takes", () => {
    const checked = campaignBodyOf(campaignDraftOf(campaign));
    expect(checked.ok && Date.parse(checked.body.startsAt)).toBe(Date.parse(campaign.startsAt));
    expect(checked.ok && Date.parse(checked.body.endsAt)).toBe(Date.parse(campaign.endsAt));
  });

  it("starts a new campaign empty", () => {
    expect(campaignBodyOf(BLANK_CAMPAIGN).ok).toBe(false);
  });
});

const quest = (status: AdminQuest["status"]): AdminQuest => ({
  id: QUEST_ID,
  campaignId: null,
  metric: "cities",
  target: 2,
  title: { ar: "العب في مدينتين", en: "Play in 2 cities" },
  xp: 300,
  gems: 25,
  position: 2,
  status,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

describe("questBodyOf and questPatchOf", () => {
  it("sends the numbers as numbers, with the campaign chosen for a new quest", () => {
    expect(questBodyOf(questDraft, CAMPAIGN_ID)).toEqual({
      ok: true,
      body: {
        metric: "events",
        target: 3,
        title: { ar: "شارك في 3 فعاليات", en: "Attend 3 events" },
        xp: 300,
        gems: 0,
        position: 1,
        status: "draft",
        campaignId: CAMPAIGN_ID,
      },
    });
    expect(questBodyOf(questDraft, null)).toMatchObject({ ok: true, body: { campaignId: null } });
  });

  it("leaves the campaign out of an edit, which can never move it", () => {
    const checked = questPatchOf({ ...questDraft, status: "active" });
    expect(checked.ok && Object.keys(checked.body).toSorted()).toEqual([
      "gems",
      "metric",
      "position",
      "status",
      "target",
      "title",
      "xp",
    ]);
  });

  it.each([
    ["a missing target", { target: "" }, "target"],
    ["a target of 0", { target: "0" }, "target"],
    ["a target past 1000", { target: "1001" }, "target"],
    ["a fractional target", { target: "2.5" }, "target"],
    ["no XP", { xp: "" }, "xp"],
    ["XP past 10000", { xp: "10001" }, "xp"],
    ["no gems", { gems: "" }, "gems"],
    ["gems past 1000", { gems: "1001" }, "gems"],
    ["fractional gems", { gems: "2.5" }, "gems"],
    ["negative gems", { gems: "-1" }, "gems"],
    ["a position of 0", { position: "0" }, "position"],
    ["no Arabic title", { titleAr: "" }, "label"],
    ["a title past 80 characters", { titleEn: "x".repeat(81) }, "label"],
  ] as const)("refuses %s before sending", (_name, patch, field) => {
    expect(questBodyOf({ ...questDraft, ...patch }, null)).toEqual({ ok: false, field });
    expect(questPatchOf({ ...questDraft, ...patch })).toEqual({ ok: false, field });
  });

  it("sends the gems a quest pays, 0 to 1000, and starts a new quest at 0", () => {
    expect(BLANK_QUEST.gems).toBe("0");
    expect(questPatchOf({ ...questDraft, gems: "25" })).toMatchObject({
      ok: true,
      body: { gems: 25 },
    });
    expect(questPatchOf({ ...questDraft, gems: "1000" }).ok).toBe(true);
    expect(questPatchOf({ ...questDraft, gems: "0" }).ok).toBe(true);
    expect(questDraftOf(quest("active")).gems).toBe("25");
  });

  it("shows an active quest as active and a draft or retired one as a draft in the form", () => {
    expect(questDraftOf(quest("active"))).toMatchObject({ status: "active", target: "2" });
    expect(questDraftOf(quest("draft")).status).toBe("draft");
    expect(questDraftOf(quest("retired")).status).toBe("draft");
  });
});

const refused = (code: string, details: unknown) => ({ code, message: {}, details });

describe("refusalKey", () => {
  it.each([
    "retired",
    "start_passed",
    "started",
    "ends_earlier",
    "ended",
    "frozen",
    "too_many",
    "campaign_closed",
  ])("words the 409 questify_conflict reason %s", (reason) => {
    const key = refusalKey(refused("questify_conflict", { reason }));
    expect(key).toMatch(/^console\.questify\.conflict\./);
    expect(key).not.toBe("console.questify.conflict.other");
    expect(key && key in MESSAGES).toBe(true);
  });

  it("gives a reason it does not know the general conflict text", () => {
    expect(refusalKey(refused("questify_conflict", { reason: "new_one" }))).toBe(
      "console.questify.conflict.other",
    );
    expect(refusalKey(refused("questify_conflict", {}))).toBe("console.questify.conflict.other");
  });

  it.each([
    ["name", "label"],
    ["title", "label"],
    ["startsAt", "startsAt"],
    ["endsAt", "endsAt"],
    ["target", "target"],
    ["xp", "xp"],
    ["gems", "gems"],
    ["position", "position"],
    ["campaignId", "other"],
    ["status", "other"],
  ])("words the 422 invalid_questify field %s", (field, expected) => {
    expect(refusalKey(refused("invalid_questify", { field }))).toBe(
      invalidKey(expected as "other"),
    );
  });

  it("says the general invalid text for a 422 with no field", () => {
    expect(refusalKey(refused("invalid_questify", {}))).toBe("console.questify.invalid.other");
  });

  it("leaves every other answer to the API's own message", () => {
    expect(refusalKey(refused("forbidden", {}))).toBeUndefined();
    expect(refusalKey(undefined)).toBeUndefined();
    expect(refusalKey("oops")).toBeUndefined();
  });

  it("has a message in both languages for every key it can answer", () => {
    for (const key of Object.keys(MESSAGES).filter((name) =>
      name.startsWith("console.questify."),
    )) {
      const text = MESSAGES[key as keyof typeof MESSAGES];
      expect(text.ar.length, key).toBeGreaterThan(0);
      expect(text.en.length, key).toBeGreaterThan(0);
    }
  });
});

describe("readAdminQuestify", () => {
  it("reads the page's answer and refuses anything else", () => {
    expect(readAdminQuestify({ alwaysOn: [], campaigns: [] })).toEqual({
      alwaysOn: [],
      campaigns: [],
    });
    expect(readAdminQuestify({ alwaysOn: [] })).toBeUndefined();
    expect(readAdminQuestify(undefined)).toBeUndefined();
  });
});

describe("saudiStamp", () => {
  it("shows an instant as the Saudi date and time with Western digits", () => {
    expect(saudiStamp("2026-12-01T06:00:00.000Z", "en")).toBe("1 Dec 2026 09:00");
    expect(saudiStamp("2026-12-01T06:00:00.000Z", "ar")).toMatch(/^1 .+ 2026 09:00$/);
  });

  it("moves to the next Saudi day after 21:00 UTC", () => {
    expect(saudiStamp("2026-12-01T21:30:00.000Z", "en")).toBe("2 Dec 2026 00:30");
  });
});

const campaignWith = (status: AdminCampaign["status"]): AdminCampaign => ({
  id: CAMPAIGN_ID,
  name: { ar: "موسم", en: "Season" },
  startsAt: "2026-12-01T06:00:00.000Z",
  endsAt: "2026-12-31T18:30:00.000Z",
  status,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});
describe("questCanPay", () => {
  it("fixes the gems of an active always-on quest and of an active quest in a published campaign", () => {
    expect(questCanPay(quest("active"), null)).toBe(true);
    expect(questCanPay(quest("active"), campaignWith("published"))).toBe(true);
  });

  it("leaves the gems of a draft, of a quest in a draft campaign and of a retired quest editable", () => {
    expect(questCanPay(quest("draft"), null)).toBe(false);
    expect(questCanPay(quest("active"), campaignWith("draft"))).toBe(false);
    expect(questCanPay(quest("retired"), null)).toBe(false);
  });
});
