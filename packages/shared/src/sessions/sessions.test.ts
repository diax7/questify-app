import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import {
  parseSessionsCsv,
  sessionBodySchema,
  sessionIssue,
  sessionReportCsv,
  SESSION_CSV_COLUMNS,
  type TeamSession,
} from "#src/sessions/sessions";

const ZONE = "Asia/Riyadh";
const WINDOW = { startsAt: "2026-11-02T00:00:00+03:00", endsAt: "2026-11-04T20:00:00+03:00" };
const HEADER = SESSION_CSV_COLUMNS.join(",");

const base = {
  kind: "talk",
  titleEn: "Keynote",
  startsAt: "2026-11-02T10:00:00+03:00",
  endsAt: "2026-11-02T11:00:00+03:00",
  access: "open",
} as const;

describe("session checks", () => {
  it("accepts a session and names the first field that cannot be saved", () => {
    expect(sessionIssue(base, WINDOW)).toBeNull();
    expect(sessionIssue({ ...base, titleEn: " " }, WINDOW)).toBe("title");
    expect(sessionIssue({ ...base, endsAt: base.startsAt }, WINDOW)).toBe("endsAt:before_start");
    expect(sessionIssue({ ...base, endsAt: "2026-11-03T11:00:00+03:00" }, WINDOW)).toBe(
      "endsAt:too_long",
    );
    expect(sessionIssue({ ...base, startsAt: "2026-11-01T22:00:00+03:00" }, WINDOW)).toBe(
      "startsAt:outside_event",
    );
    expect(
      sessionIssue(
        { ...base, access: "registration", closesAt: "2026-11-02T10:30:00+03:00" },
        WINDOW,
      ),
    ).toBe("closesAt");
  });

  it("an event with no dates accepts any time", () => {
    expect(sessionIssue(base, { startsAt: null, endsAt: null })).toBeNull();
  });

  it("refuses an unknown field, a price and a control character", () => {
    expect(sessionBodySchema.safeParse({ ...base, price: 10 }).success).toBe(false);
    expect(sessionBodySchema.safeParse({ ...base, titleEn: "a\u0007b" }).success).toBe(false);
    expect(sessionBodySchema.safeParse({ ...base, descriptionEn: "line\nbreak" }).success).toBe(
      true,
    );
    expect(sessionBodySchema.safeParse({ ...base, speakers: Array(11).fill("A") }).success).toBe(
      false,
    );
  });
});

describe("importing sessions", () => {
  it("reads rows in the event's zone and lists the ones it cannot read with the reason", () => {
    const csv = [
      HEADER,
      "talk,Keynote,الافتتاح,2026-11-02 10:00,2026-11-02 11:00,Hall A,القاعة أ,Sara; Omar,About us,,open,",
      "workshop,AI,,2026-11-02 12:00,2026-11-02 13:30,,,,,,registration,40",
      "party,Bad kind,,2026-11-02 12:00,2026-11-02 13:00,,,,,,,",
      "talk,Bad time,,tomorrow,2026-11-02 13:00,,,,,,,",
      "talk,Backwards,,2026-11-02 14:00,2026-11-02 13:00,,,,,,,",
      "talk,,,2026-11-02 14:00,2026-11-02 15:00,,,,,,,",
      "talk,Outside,,2026-12-02 14:00,2026-12-02 15:00,,,,,,,",
      "workshop,Seats,,2026-11-02 12:00,2026-11-02 13:00,,,,,,registration,many",
      "talk,Points,,2026-11-02 12:00,2026-11-02 13:00,,,,,,open,,lots",
    ].join("\n");
    const result = parseSessionsCsv(csv, ZONE, WINDOW);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      kind: "talk",
      titleEn: "Keynote",
      titleAr: "الافتتاح",
      startsAt: "2026-11-02T07:00:00.000Z",
      speakers: ["Sara", "Omar"],
      access: "open",
      seats: null,
    });
    expect(result.rows[1]).toMatchObject({ access: "registration", seats: 40 });
    expect(result.failed).toEqual([
      { line: 4, issue: "kind" },
      { line: 5, issue: "startsAt" },
      { line: 6, issue: "endsAt:before_start" },
      { line: 7, issue: "title" },
      { line: 8, issue: "startsAt:outside_event" },
      { line: 9, issue: "seats" },
      { line: 10, issue: "points" },
    ]);
    expect(result.rows[0]?.points).toBe(0);
  });

  it("reads a session's points from the optional points column (T-505b)", () => {
    const csv = [
      HEADER,
      "talk,Paid,,2026-11-02 10:00,2026-11-02 11:00,,,,,,open,,٥٠",
      "talk,Too many,,2026-11-02 10:00,2026-11-02 11:00,,,,,,open,,100001",
    ].join("\n");
    const result = parseSessionsCsv(csv, ZONE, WINDOW);
    expect(result.rows[0]).toMatchObject({ titleEn: "Paid", points: 50 });
    expect(result.failed).toEqual([{ line: 3, issue: "points" }]);
  });

  it("reads a semicolon file with a byte-order mark, Arabic-Indic digits and quoted cells", () => {
    const csv = `﻿${SESSION_CSV_COLUMNS.join(";")}\r\ntalk;"Hello; ""world""";;٢٠٢٦-١١-٠٢ ١٠:٠٠;2026-11-02 11:00;;;;;;registration;٥٠\r\n`;
    const result = parseSessionsCsv(csv, ZONE, WINDOW);
    expect(result.failed).toEqual([]);
    expect(result.rows[0]).toMatchObject({ titleEn: 'Hello; "world"', seats: 50 });
  });

  it("reads columns by name in any order and ignores blank lines", () => {
    const csv = "Start,End,Type,Title EN\n2026-11-02 10:00,2026-11-02 11:00,activity,Games\n\n";
    const result = parseSessionsCsv(csv, ZONE, WINDOW);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ kind: "activity", titleEn: "Games" });
  });

  it("reads at most 500 data rows", () => {
    const line = "talk,T,,2026-11-02 10:00,2026-11-02 11:00,,,,,,,";
    const result = parseSessionsCsv([HEADER, ...Array(520).fill(line)].join("\n"), ZONE, WINDOW);
    expect(result.rows).toHaveLength(500);
  });
});

describe("the attendance report", () => {
  const session: TeamSession = {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "workshop",
    titleAr: null,
    titleEn: '=SUM(1,2) "x"',
    descriptionAr: null,
    descriptionEn: null,
    placeAr: null,
    placeEn: "Hall A",
    speakers: [],
    startsAt: "2026-11-02T07:00:00.000Z",
    endsAt: "2026-11-02T08:00:00.000Z",
    access: "registration",
    seats: 40,
    closesAt: null,
    registrationOpen: true,
    walkIns: false,
    reminderMinutes: 15,
    questId: null,
    points: 0,
    registered: 30,
    attended: 25,
    walkInCount: 2,
    noShows: 7,
  };

  it("lists the numbers with a byte-order mark, the event's local time and no live formula", () => {
    const csv = sessionReportCsv([session], ZONE, [
      "Title",
      "Type",
      "Start",
      "Place",
      "Seats",
      "R",
      "A",
      "W",
      "N",
    ]);
    const lines = csv.trim().split("\r\n");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines[1]).toBe(`"'=SUM(1,2) ""x""",workshop,2026-11-02 10:00,Hall A,40,30,25,2,7`);
  });

  it("shows zeros for a session nobody registered for", () => {
    const empty = {
      ...session,
      registered: 0,
      attended: 0,
      walkInCount: 0,
      noShows: 0,
      seats: null,
    };
    expect(sessionReportCsv([empty], ZONE, ["T"]).trim().split("\r\n")[1]).toMatch(/,,0,0,0,0$/);
  });
});

describe("the agenda's words", () => {
  it("has an issue message for every reason the database or the import names", () => {
    const reasons = [
      "session",
      "kind",
      "title",
      "startsAt",
      "endsAt",
      "access",
      "seats",
      "speakers",
      "closesAt",
      "questId",
      "reminderMinutes",
      "points",
      "rows",
    ];
    for (const reason of reasons)
      expect(MESSAGES[`sessions.issue.${reason}` as keyof typeof MESSAGES]).toBeDefined();
  });
});
