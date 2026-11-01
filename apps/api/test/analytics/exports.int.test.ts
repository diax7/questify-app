import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserHeaders,
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { EXPORT_LIMITS } from "#src/analytics/export-gate";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
const BOM = String.fromCharCode(0xfeff);
const LINE_BREAK = String.fromCharCode(13, 10);
const lines = (body: string) => body.replace(BOM, "").trimEnd().split(LINE_BREAK);

/**
 * The event's spreadsheets, sponsor totals and one-page report over HTTP (T-608, FR-1206 to FR-1208, FR-1306,
 * FR-1626): only what the join card disclosed, a floor on a sponsor's counts, an audit entry for every export, and a
 * refusal for anyone who is not the event's own team.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("exports over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerId = "";
  let ownerCookie = "";
  let counter = 0;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [row] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, name_ar, status, starts_at, ends_at)
       VALUES ($1, $2, 'Export Fest', 'مهرجان', 'live', now() - interval '1 hour', now() + interval '1 day')
       RETURNING id`,
      [organizer, `EXP${counter}`],
    );
    const id = row?.id ?? "";
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [id]);
    return id;
  };
  const newQuest = async (ev: string, title = "Find the stage"): Promise<string> =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible)
         SELECT $1, id, 'scan_qr', $2, 10, 3, true FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [ev, title],
      )
    )[0]?.id ?? "";
  const join = async (ev: string, questId?: string): Promise<string> => {
    counter += 1;
    const username = `exporter_${counter}`;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [username],
    );
    await owner("INSERT INTO player_contact (player_id, email, phone_e164) VALUES ($1, $2, $3)", [
      player?.id,
      `export${counter}@private.test`,
      `+9665${String(counter).padStart(8, "0")}`,
    ]);
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, 'code') RETURNING id",
      [organizer, ev, player?.id],
    );
    if (questId !== undefined) {
      await owner(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'qr', $5)`,
        [organizer, ev, enrolled?.id, questId, randomUUID()],
      );
    }
    return username;
  };
  const newSponsor = async (ev: string, name: string, questId?: string): Promise<string> => {
    const [sponsor] = await owner<{ id: string }>(
      `INSERT INTO sponsor (organizer_id, event_id, name_en, tier, created_by)
       VALUES ($1, $2, $3, 'gold', $4) RETURNING id`,
      [organizer, ev, name, ownerId],
    );
    if (questId !== undefined) {
      await owner(
        `INSERT INTO sponsor_tag (organizer_id, event_id, sponsor_id, kind, quest_id, created_by)
         VALUES ($1, $2, $3, 'quest', $4, $5)`,
        [organizer, ev, sponsor?.id, questId, ownerId],
      );
    }
    return sponsor?.id ?? "";
  };
  const exportFile = (
    ev: string,
    kind: string,
    body: Row = { language: "en" },
    cookie: string | null = ownerCookie,
    org = organizer,
  ) =>
    test.app.inject({
      method: "POST",
      url: `/v1/organizers/${org}/events/${ev}/exports/${kind}`,
      payload: body,
      headers: cookie === null ? browserHeaders() : withSession(cookie),
    });

  const totals = (ev: string, sponsor: string, cookie: string | null = ownerCookie) =>
    test.app.inject({
      method: "GET",
      url: `/v1/organizers/${organizer}/events/${ev}/analytics/sponsors/${sponsor}`,
      ...(cookie === null ? {} : { headers: withSession(cookie) }),
    });
  const reportAs = (method: "GET" | "POST", ev: string, cookie: string | null = ownerCookie) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}/events/${ev}/report`,
      headers: cookie === null ? browserHeaders() : withSession(cookie),
    });
  const report = (ev: string, cookie: string | null = ownerCookie) => reportAs("GET", ev, cookie);
  const printReport = (ev: string, cookie: string | null = ownerCookie) =>
    reportAs("POST", ev, cookie);
  const signedInEditor = async (email: string) => {
    const staff = await createStaff(db.owner, { email });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
      [organizer, staff],
    );
    return signInFully(test, email);
  };
  const auditKinds = async (ev: string) =>
    (
      await owner<{ after: Row }>(
        "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.export' ORDER BY id",
        [ev],
      )
    ).map((entry) => entry.after);

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('exports-org', 'exports-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    ownerId = await createStaff(db.owner, { email: "owner@exports.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    ownerCookie = await signInFully(test, "owner@exports.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("exports the players with their join answers and nothing the join card did not disclose", async () => {
    const ev = await newEvent();
    const [field] = await owner<{ id: string }>(
      "INSERT INTO event_join_field (event_id, kind, required, position) VALUES ($1, 'company', true, 0) RETURNING id",
      [ev],
    );
    const name = await join(ev);
    await owner(
      `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
       SELECT n.id, $2, n.organizer_id, n.event_id, '=Acme' FROM enrollment n WHERE n.event_id = $1`,
      [ev, field?.id],
    );
    const answer = await exportFile(ev, "players");
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    expect(answer.body.startsWith(BOM)).toBe(true);
    const [header, row] = lines(answer.body);
    expect(header).toBe("Username,Company,Status,Joined at,Points");
    expect(row).toMatch(new RegExp(`^${name},'=Acme,active,\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2},0$`));
    expect(answer.body).not.toMatch(/private\.test|\+966|@/);
  });

  it("writes Arabic headers for an Arabic request and Western digits", async () => {
    const ev = await newEvent();
    await join(ev);
    const answer = await exportFile(ev, "players", { language: "ar" });
    const [header, row] = lines(answer.body);
    expect(header).toBe("اسم المستخدم,الحالة,وقت الانضمام,النقاط");
    expect(row).not.toMatch(/[٠-٩]/u);
  });

  it("exports an event with nothing to list as the header alone", async () => {
    const ev = await newEvent();
    for (const [kind, header] of [
      ["players", "Username,Status,Joined at,Points"],
      [
        "completions",
        "Username,Quest,Category,Completed at,Time number,Method,Removed by the team",
      ],
      ["redemptions", "Username,Reward,Price,Status,Reserved at,Closed at"],
      ["submissions", "Username,Quest,Sent at,Status,Answer"],
      ["surveys", "Quest,Question,Type,Answer,Count"],
    ] as const) {
      const answer = await exportFile(ev, kind);
      expect(answer.statusCode, kind).toBe(200);
      expect(lines(answer.body), kind).toEqual([header]);
    }
  });

  it("lists every completion of the event and none of another", async () => {
    const ev = await newEvent();
    const stage = await newQuest(ev);
    const first = await join(ev, stage);
    const second = await join(ev, stage);
    const elsewhere = await newEvent();
    await join(elsewhere, await newQuest(elsewhere, "Elsewhere"));
    const rows = lines((await exportFile(ev, "completions")).body).slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(new RegExp(`^${first},Find the stage,General,`));
    expect(rows[1]).toMatch(new RegExp(`^${second},Find the stage,General,`));
    expect(rows.join("")).not.toContain("Elsewhere");
  });

  it("audits every export with its kind and no row", async () => {
    const ev = await newEvent();
    await join(ev);
    await exportFile(ev, "players");
    await exportFile(ev, "completions", { language: "ar" });
    const audit = await owner<{ action: string; after: Row; actor_id: string }>(
      "SELECT action, after, actor_id FROM audit_log WHERE event_id = $1 AND action = 'event.export' ORDER BY id",
      [ev],
    );
    expect(audit.map((entry) => entry.after)).toEqual([
      { kind: "players" },
      { kind: "completions" },
    ]);
    expect(audit.every((entry) => entry.actor_id === ownerId)).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/exporter_/);
  });

  it("gives a sponsor's totals with no player and a count under the floor in words", async () => {
    const ev = await newEvent();
    const booth = await newQuest(ev, "Booth");
    for (let i = 0; i < 3; i += 1) await join(ev, booth);
    for (let i = 0; i < 6; i += 1) await join(ev);
    const sponsor = await newSponsor(ev, "Acme", booth);
    const answer = await exportFile(ev, "sponsor", { language: "en", sponsorId: sponsor });
    expect(answer.statusCode).toBe(200);
    expect(lines(answer.body)).toEqual([
      "Group,Item,Measure,Count",
      "Totals,Acme,Visits,Fewer than 5",
      "Totals,,Completions,Fewer than 5",
      "Totals,,Redemptions,0",
      "Quest,Booth,Players,Fewer than 5",
    ]);
    expect(answer.body).not.toMatch(/exporter_|private\.test/);
  });

  it("shows zero everywhere for a sponsor with nothing tagged", async () => {
    const ev = await newEvent();
    const sponsor = await newSponsor(ev, "Nobody");
    const answer = await exportFile(ev, "sponsor", { language: "en", sponsorId: sponsor });
    expect(lines(answer.body).slice(1)).toEqual([
      "Totals,Nobody,Visits,0",
      "Totals,,Completions,0",
      "Totals,,Redemptions,0",
    ]);
  });

  it("refuses a sponsor on a player file, a sponsor file with none, a stranger sponsor and an unknown file", async () => {
    const ev = await newEvent();
    const sponsor = await newSponsor(ev, "Acme");
    const foreign = await newSponsor(await newEvent(), "Foreign");
    const refused = async (kind: string, body: Row) =>
      (await exportFile(ev, kind, body)).statusCode;
    expect(await refused("players", { language: "en", sponsorId: sponsor })).toBe(400);
    expect(await refused("sponsor", { language: "en" })).toBe(400);
    expect(await refused("sponsor", { language: "en", sponsorId: foreign })).toBe(404);
    expect(await refused("contacts", { language: "en" })).toBe(400);
    expect(await refused("players", { language: "fr" })).toBe(400);
    expect(await refused("players", { language: "en", email: true })).toBe(400);
  });

  it("refuses a stranger, another organizer's team and an unknown event, and writes no audit entry", async () => {
    const ev = await newEvent();
    const rival = (
      await owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('rival-exports', 'rival-exports') RETURNING id",
      )
    )[0]?.id as string;
    const rivalStaff = await createStaff(db.owner, { email: "owner@rival-exports.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [rival, rivalStaff],
    );
    const rivalCookie = await signInFully(test, "owner@rival-exports.test");
    for (const kind of ["players", "completions", "redemptions", "submissions", "surveys"]) {
      expect((await exportFile(ev, kind, undefined, null)).statusCode, `${kind} anonymous`).toBe(
        401,
      );
      for (const [cookie, org, target] of [
        [rivalCookie, rival, ev],
        [rivalCookie, organizer, ev],
        [ownerCookie, rival, ev],
        [ownerCookie, organizer, randomUUID()],
      ] as const) {
        const answer = await exportFile(target, kind, undefined, cookie, org);
        expect([answer.statusCode, answer.json().code], kind).toEqual([404, "not_found"]);
      }
    }
    expect(
      await owner("SELECT 1 FROM audit_log WHERE event_id = $1 AND action = 'event.export'", [ev]),
    ).toHaveLength(0);
  });

  it("keeps an editor to the events in their limit", async () => {
    const inside = await newEvent();
    const outside = await newEvent();
    const editor = await createStaff(db.owner, { email: "editor@exports.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [organizer, editor, [inside]],
    );
    const cookie = await signInFully(test, "editor@exports.test");
    expect((await exportFile(inside, "players", undefined, cookie)).statusCode).toBe(200);
    expect((await exportFile(outside, "players", undefined, cookie)).statusCode).toBe(404);
  });

  describe("sponsor totals", () => {
    it("answers visits, completions and redemptions as totals, floored, with no player", async () => {
      const ev = await newEvent();
      const booth = await newQuest(ev, "Booth");
      for (let i = 0; i < 5; i += 1) await join(ev, booth);
      await join(ev);
      const sponsor = await newSponsor(ev, "Acme", booth);
      const answer = await totals(ev, sponsor);
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["cache-control"]).toBe("private, no-store");
      expect(answer.json()).toMatchObject({
        sponsor: { name: { en: "Acme" } },
        visits: 5,
        completions: 5,
        redemptions: 0,
        quests: [{ title: { en: "Booth" }, players: 5 }],
      });
      expect(answer.body).not.toMatch(/exporter_|private\.test|enrollment/);
    });

    it("leaves a count of one to four out as null", async () => {
      const ev = await newEvent();
      const booth = await newQuest(ev, "Booth");
      await join(ev, booth);
      const sponsor = await newSponsor(ev, "Acme", booth);
      expect((await totals(ev, sponsor)).json()).toMatchObject({
        visits: null,
        completions: null,
        quests: [{ players: null }],
      });
    });

    it("refuses a stranger and a sponsor of another event with 404", async () => {
      const ev = await newEvent();
      const foreign = await newSponsor(await newEvent(), "Foreign");
      expect((await totals(ev, foreign)).statusCode).toBe(404);
      expect((await totals(ev, randomUUID())).statusCode).toBe(404);
      expect((await totals(ev, foreign, null)).statusCode).toBe(401);
      expect((await totals(ev, "not-a-uuid")).statusCode).toBe(400);
    });
  });

  describe("the one-page report", () => {
    it("answers the headline numbers, the top quests and the surveys with no player, and writes no audit entry", async () => {
      const ev = await newEvent();
      const stage = await newQuest(ev, "Main stage");
      for (let i = 0; i < 6; i += 1) await join(ev, stage);
      const answer = await report(ev);
      expect(answer.statusCode).toBe(200);
      const body = answer.json();
      expect(body.event.name).toEqual({ ar: "مهرجان", en: "Export Fest" });
      expect(body.headline).toMatchObject({ joined: 6, active: 6, activation: 100 });
      expect(body.quests).toEqual([{ title: { ar: null, en: "Main stage" }, done: 6 }]);
      expect(body.surveys).toEqual([]);
      expect(answer.headers["cache-control"]).toBe("private, no-store");
      expect(answer.body).not.toMatch(/exporter_|private\.test/);
      await report(ev);
      expect(await auditKinds(ev)).toEqual([]);
    });

    it("audits printing it, once for each print", async () => {
      const ev = await newEvent();
      const answer = await printReport(ev);
      expect([answer.statusCode, answer.body]).toEqual([204, ""]);
      expect(answer.headers["cache-control"]).toBe("private, no-store");
      await printReport(ev);
      expect(await auditKinds(ev)).toEqual([{ kind: "report" }, { kind: "report" }]);
    });

    it("leaves a quest done by one to four players out", async () => {
      const ev = await newEvent();
      await join(ev, await newQuest(ev, "Quiet corner"));
      expect((await report(ev)).json().quests).toEqual([
        { title: { ar: null, en: "Quiet corner" }, done: null },
      ]);
    });

    it("refuses a stranger and an unknown event", async () => {
      const ev = await newEvent();
      for (const ask of [report, printReport]) {
        expect((await ask(ev, null)).statusCode).toBe(401);
        expect((await ask(randomUUID())).statusCode).toBe(404);
      }
      expect(await auditKinds(ev)).toEqual([]);
    });
  });

  describe("limits on starting an export", () => {
    it("lets one export of an event run at a time, and writes no audit entry for the refused", async () => {
      const ev = await newEvent();
      await join(ev);
      const cookie = await signedInEditor("single-flight@exports.test");
      const answers = await Promise.all(
        Array.from({ length: 6 }, () => exportFile(ev, "completions", undefined, cookie)),
      );
      const done = answers.filter((answer) => answer.statusCode === 200);
      const refused = answers.filter((answer) => answer.statusCode === 429);
      expect(done.length + refused.length).toBe(answers.length);
      expect(done.length).toBeGreaterThanOrEqual(1);
      expect(refused.length).toBeGreaterThanOrEqual(1);
      expect(refused.every((answer) => answer.json().code === "export_running")).toBe(true);
      expect(await auditKinds(ev)).toHaveLength(done.length);
      expect((await exportFile(ev, "completions", undefined, cookie)).statusCode).toBe(200);
    });

    it("limits the starts of one staff member, with the wait, and not the others", async () => {
      const ev = await newEvent();
      const cookie = await signedInEditor("rate-limit@exports.test");
      for (let i = 0; i < EXPORT_LIMITS.perStaff; i += 1) {
        expect((await printReport(ev, cookie)).statusCode, `start ${i + 1}`).toBe(204);
      }
      const refused = await printReport(ev, cookie);
      expect([refused.statusCode, refused.json().code]).toEqual([429, "too_many_exports"]);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      expect((await exportFile(ev, "players", undefined, cookie)).statusCode).toBe(429);
      expect(await auditKinds(ev)).toHaveLength(EXPORT_LIMITS.perStaff);
      const other = await signedInEditor("rate-limit-other@exports.test");
      expect((await printReport(ev, other)).statusCode).toBe(204);
    });
  });
});
