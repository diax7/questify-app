import { describe, expect, it } from "vitest";
import { sponsorTotals } from "#src/analytics/sponsor";
import {
  completionsTable,
  exportBodySchema,
  playersTable,
  sponsorRows,
  surveysRows,
  type ExportStart,
  type SurveyExport,
} from "#src/exports/exports";
import { MESSAGES } from "#src/i18n/messages";
import { createTranslator } from "#src/i18n/translate";
import { csvFile } from "#src/text/csv";

const translate = createTranslator(MESSAGES);
type Key = Parameters<typeof translate>[0];
type Params = Record<string, string | number>;
const english = (key: Key, params?: Params) => translate(key, "en", params);
const arabic = (key: Key, params?: Params) => translate(key, "ar", params);
const ID = "7d9f3f8e-2b1c-4c43-8f0e-0a2b9f9a1111";
const OTHER = "7d9f3f8e-2b1c-4c43-8f0e-0a2b9f9a2222";

const fields: ExportStart["fields"] = [
  { id: ID, kind: "company", label: { ar: null, en: null } },
  { id: OTHER, kind: "custom", label: { ar: "المدينة", en: "City" } },
];
const player = (username: string, answers: Record<string, string> = {}) => ({
  username,
  status: "active",
  joinedAt: "2026-10-31 10:00",
  points: 30,
  answers,
});

describe("the players file", () => {
  it("has the username, the join fields in the card order, then status, joined at and points", () => {
    const table = playersTable(fields, "en", english);
    expect(table.header).toEqual(["Username", "Company", "City", "Status", "Joined at", "Points"]);
    expect(table.cells(player("sara", { [ID]: "Acme" }))).toEqual([
      "sara",
      "Acme",
      "",
      "active",
      "2026-10-31 10:00",
      30,
    ]);
  });

  it("names a custom field in the file language and writes Arabic headers", () => {
    expect(playersTable(fields, "ar", arabic).header.slice(0, 3)).toEqual([
      "اسم المستخدم",
      "جهة العمل",
      "المدينة",
    ]);
  });

  it("is the header alone for an event with no players", () => {
    const table = playersTable(fields, "en", english);
    expect(csvFile([table.header])).toBe("﻿Username,Company,City,Status,Joined at,Points\r\n");
  });

  it("writes a text that starts like a formula as text", () => {
    const table = playersTable([], "en", english);
    expect(csvFile([table.cells(player("=HYPERLINK(1)"))])).toContain("'=HYPERLINK(1)");
  });
});

describe("the completions file", () => {
  it("marks a completion the team removed and writes the quest in the file language", () => {
    const table = completionsTable("ar", arabic);
    const row = {
      username: "sara",
      quest: { ar: "المسرح", en: "Stage" },
      category: { ar: null, en: "Hall" },
      completedAt: "2026-10-31 10:00",
      occurrence: 2,
      method: "qr",
      removed: true,
    };
    expect(table.cells(row)).toEqual([
      "sara",
      "المسرح",
      "Hall",
      "2026-10-31 10:00",
      2,
      "qr",
      "نعم",
    ]);
    expect(table.cells({ ...row, removed: false }).at(-1)).toBe("");
  });
});

const survey = (total: number): SurveyExport => ({
  quest: { ar: null, en: "Feedback" },
  results: {
    total,
    questions: [
      {
        id: "a",
        kind: "rating",
        text: { ar: null, en: "How was it?" },
        answered: total,
        choices: null,
        average: total === 0 ? null : 4.5,
        texts: null,
      },
    ],
  },
});

describe("the surveys file", () => {
  it("leads every line with the quest and says so when nobody answered", () => {
    expect(surveysRows([survey(0)], "en", english)).toEqual([
      ["Quest", "Question", "Type", "Answer", "Count"],
      ["Feedback", "No answers were received.", "", "", 0],
    ]);
    expect(surveysRows([survey(3)], "en", english)[1]).toEqual([
      "Feedback",
      "Responses",
      "",
      "",
      3,
    ]);
  });

  it("is the header alone for an event with no survey", () => {
    expect(surveysRows([], "en", english)).toHaveLength(1);
  });
});

describe("the sponsor file", () => {
  it("writes totals and items with no player, and a count under the floor in words", () => {
    const rows = sponsorRows(
      sponsorTotals({
        sponsor: { id: ID, name: { ar: null, en: "Acme" } },
        visits: 3,
        completions: 20,
        redemptions: 0,
        quests: [{ id: ID, title: { ar: null, en: "Stage" }, players: 12 }],
        categories: [],
        rewards: [],
      }),
      "en",
      english,
    );
    expect(rows[1]).toEqual(["Totals", "Acme", "Visits", "Fewer than 5"]);
    expect(rows[2]).toEqual(["Totals", "", "Completions", 20]);
    expect(rows[3]).toEqual(["Totals", "", "Redemptions", 0]);
    expect(rows[4]).toEqual(["Quest", "Stage", "Players", 12]);
    expect(JSON.stringify(rows)).not.toMatch(/username/i);
  });
});

describe("the export request", () => {
  it("takes a language and, for a sponsor, the sponsor, and nothing else", () => {
    expect(exportBodySchema.safeParse({ language: "en" }).success).toBe(true);
    expect(exportBodySchema.safeParse({ language: "en", sponsorId: ID }).success).toBe(true);
    expect(exportBodySchema.safeParse({ language: "fr" }).success).toBe(false);
    expect(exportBodySchema.safeParse({ language: "en", email: "x@y.z" }).success).toBe(false);
  });
});
