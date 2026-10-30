import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
const HOUR = 3600 * 1000;

/**
 * Rank prizes and final results over HTTP (T-214): the prize editor with its audit, the switch and the rules text, the
 * results page, the owner's confirm and reveal, the player's results and rules, the public rules page, Home's win
 * card, and the refusals the desk, the shop and removals gain.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("rank prizes and results over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let editorCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Najd Events', 'rank-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    for (const [email, role] of [
      ["owner@rank.test", "owner"],
      ["editor@rank.test", "editor"],
    ] as const) {
      const id = await createStaff(db.owner, { email });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, $3)",
        [organizer, id, role],
      );
    }
    ownerCookie = await signInFully(test, "owner@rank.test");
    editorCookie = await signInFully(test, "editor@rank.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (phase: "ended" | "draft" | "live" = "ended") => {
    counter += 1;
    const ends = phase === "ended" ? "now() - interval '1 hour'" : "now() + interval '1 day'";
    const [event] = await owner<{ id: string; join_code: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en)
       VALUES ($1, $2, 'Rank Fest', $3, now() - interval '2 days', ${ends}, 'Hall B') RETURNING id, join_code`,
      [organizer, `RANKH${counter}`, phase === "draft" ? "draft" : "live"],
    );
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [event?.id]);
    return { id: event?.id ?? "", code: event?.join_code ?? "" };
  };

  /** A member holding `points`, with a bearer session; returns the ledger entry too. */
  const newPlayer = async (event: string, points: number) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`rank_h_${counter}`],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player?.id, createHash("sha256").update(token).digest()],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [organizer, event, player?.id],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points)
       SELECT $1, id, 'scan_qr', 'Lion', $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [event, points],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5, now() - interval '3 hours') RETURNING id`,
      [organizer, event, enrolled?.id, quest?.id, randomUUID()],
    );
    const [entry] = await owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player') RETURNING id`,
      [organizer, event, enrolled?.id, points, done?.id, quest?.id],
    );
    return { id: player?.id ?? "", token, enrollment: enrolled?.id ?? "", entry: entry?.id ?? "" };
  };

  const dashboard = (
    cookie: string,
    method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
    path: string,
    payload?: object,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const asPlayer = (token: string, url: string, method: "GET" | "POST" = "GET") =>
    test.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    });

  const audits = (event: string, prefix: string) =>
    owner<{ action: string; before: Row | null; after: Row | null }>(
      "SELECT action, before, after FROM audit_log WHERE event_id = $1 AND action LIKE $2 ORDER BY id",
      [event, `${prefix}%`],
    );

  describe("the prize editor", () => {
    it("adds, edits, lists and removes prizes, auditing each write", async () => {
      const { id: event } = await newEvent("draft");
      const made = await dashboard(editorCookie, "POST", `/events/${event}/rank-prizes`, {
        kind: "item",
        rankFrom: 1,
        rankTo: 3,
        name: { en: "Hoodie", ar: "هودي" },
      });
      expect(made.statusCode).toBe(201);
      const prize = made.json<{ prize: { id: string } }>().prize;
      expect(prize).toMatchObject({
        rankFrom: 1,
        rankTo: 3,
        kind: "item",
        name: { ar: "هودي", en: "Hoodie" },
      });

      const edited = await dashboard(
        editorCookie,
        "PATCH",
        `/events/${event}/rank-prizes/${prize.id}`,
        {
          rankTo: 2,
          description: { en: "Size M" },
        },
      );
      expect(edited.json()).toMatchObject({
        prize: { rankTo: 2, description: { ar: null, en: "Size M" } },
      });

      const overlap = await dashboard(ownerCookie, "POST", `/events/${event}/rank-prizes`, {
        kind: "experience",
        rankFrom: 2,
        rankTo: 2,
        name: { en: "Tour" },
      });
      expect([overlap.statusCode, overlap.json().code]).toEqual([409, "overlap"]);
      const backwards = await dashboard(ownerCookie, "POST", `/events/${event}/rank-prizes`, {
        kind: "experience",
        rankFrom: 5,
        rankTo: 4,
        name: { en: "Tour" },
      });
      expect([backwards.statusCode, backwards.json().details]).toEqual([400, { field: "rankTo" }]);
      const nameless = await dashboard(ownerCookie, "POST", `/events/${event}/rank-prizes`, {
        kind: "experience",
        rankFrom: 5,
        rankTo: 5,
        name: { en: "  " },
      });
      expect(nameless.json().details).toEqual({ field: "name" });

      const listed = await dashboard(editorCookie, "GET", `/events/${event}/rank-prizes`);
      expect(listed.json()).toMatchObject({
        rankPrizes: true,
        rules: { ar: null, en: null },
        prizes: [{ id: prize.id, rankTo: 2 }],
      });
      const removed = await dashboard(
        editorCookie,
        "DELETE",
        `/events/${event}/rank-prizes/${prize.id}`,
      );
      expect(removed.statusCode).toBe(204);
      const again = await dashboard(
        editorCookie,
        "DELETE",
        `/events/${event}/rank-prizes/${prize.id}`,
      );
      expect(again.statusCode).toBe(404);

      expect((await audits(event, "rank_prize.")).map((a) => a.action)).toEqual([
        "rank_prize.create",
        "rank_prize.update",
        "rank_prize.remove",
      ]);
      const [update] = await audits(event, "rank_prize.update");
      expect(update).toMatchObject({
        before: { rankTo: 3, descriptionEn: null },
        after: { rankTo: 2, descriptionEn: "Size M" },
      });
    });

    it("writes the switch and the rules text, and locks ranges once live", async () => {
      const { id: event } = await newEvent("live");
      const settings = await dashboard(editorCookie, "PUT", `/events/${event}/rank-prizes`, {
        rules: { en: "Bring your ID.", ar: "أحضر هويتك." },
      });
      expect(settings.json()).toEqual({
        rankPrizes: true,
        rules: { ar: "أحضر هويتك.", en: "Bring your ID." },
      });
      const locked = await dashboard(editorCookie, "PUT", `/events/${event}/rank-prizes`, {
        rankPrizes: false,
      });
      expect([locked.statusCode, locked.json().code]).toEqual([409, "prizes_locked"]);
      const adding = await dashboard(editorCookie, "POST", `/events/${event}/rank-prizes`, {
        kind: "experience",
        rankFrom: 1,
        rankTo: 1,
        name: { en: "Tour" },
      });
      expect([adding.statusCode, adding.json().code]).toEqual([409, "prizes_locked"]);
      expect((await audits(event, "event.rules")).map((a) => a.after)).toEqual([
        { ar: "أحضر هويتك.", en: "Bring your ID." },
      ]);
      const draft = await newEvent("draft");
      await dashboard(editorCookie, "PUT", `/events/${draft.id}/rank-prizes`, {
        rankPrizes: false,
      });
      expect((await audits(draft.id, "event.rank_prizes")).map((a) => [a.before, a.after])).toEqual(
        [[{ on: true }, { on: false }]],
      );
      const item = await dashboard(editorCookie, "POST", `/events/${draft.id}/rank-prizes`, {
        kind: "item",
        rankFrom: 1,
        rankTo: 1,
        name: { en: "Cup" },
      });
      expect(item.statusCode).toBe(201);
    });

    it("answers 404 for another organizer's event and refuses an item without the desk", async () => {
      const [other] = await owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Other', 'rank-other') RETURNING id",
      );
      const [theirs] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'RANKOTH', 'Theirs') RETURNING id`,
        [other?.id],
      );
      const stolen = await dashboard(ownerCookie, "GET", `/events/${theirs?.id}/rank-prizes`);
      expect(stolen.statusCode).toBe(404);
      const { id: event } = await newEvent("draft");
      await owner("UPDATE event SET desk_location_en = NULL WHERE id = $1", [event]);
      const item = await dashboard(ownerCookie, "POST", `/events/${event}/rank-prizes`, {
        kind: "item",
        rankFrom: 1,
        rankTo: 1,
        name: { en: "Cup" },
      });
      expect([item.statusCode, item.json().code]).toEqual([409, "desk_needed"]);
    });
  });

  describe("results", () => {
    it("shows the places with flags, confirms for the owner only, and refuses a stale list", async () => {
      const { id: event } = await newEvent();
      const first = await newPlayer(event, 300);
      const second = await newPlayer(event, 200);
      await owner(
        "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 1, 1, 'item', 'Gold')",
        [event],
      );
      await owner(
        "INSERT INTO flag (organizer_id, event_id, enrollment_id, kind) VALUES ($1, $2, $3, 'burst')",
        [organizer, event, second.enrollment],
      );
      const read = await dashboard(editorCookie, "GET", `/events/${event}/results`);
      expect(read.json()).toMatchObject({
        state: "open",
        rankPrizes: true,
        confirmedAt: null,
        places: [
          {
            rank: 1,
            enrollmentId: first.enrollment,
            score: 300,
            openFlags: 0,
            prize: { kind: "item", name: { en: "Gold" } },
          },
          {
            rank: 2,
            enrollmentId: second.enrollment,
            openFlags: 1,
            flagKinds: ["burst"],
            prize: null,
            prizeStatus: null,
          },
        ],
      });
      const expected = [first.enrollment, second.enrollment];
      const editor = await dashboard(editorCookie, "POST", `/events/${event}/results/confirm`, {
        expected,
      });
      expect(editor.statusCode).toBe(403);
      const stale = await dashboard(ownerCookie, "POST", `/events/${event}/results/confirm`, {
        expected: [second.enrollment, first.enrollment],
      });
      expect([stale.statusCode, stale.json().code]).toEqual([409, "results_changed"]);
      const bad = await dashboard(ownerCookie, "POST", `/events/${event}/results/confirm`, {
        expected: ["x"],
      });
      expect(bad.statusCode).toBe(400);
      const confirmed = await dashboard(ownerCookie, "POST", `/events/${event}/results/confirm`, {
        expected,
      });
      expect(confirmed.json()).toMatchObject({
        state: "confirmed",
        places: [{ rank: 1 }, { rank: 2 }],
      });

      const removal = await dashboard(
        ownerCookie,
        "POST",
        `/events/${event}/entries/${first.entry}/remove`,
        {
          reason: "Cheated",
        },
      );
      expect([removal.statusCode, removal.json().code]).toEqual([409, "results_final"]);
    });

    it("refuses confirming before the end", async () => {
      const { id: event } = await newEvent("live");
      const early = await dashboard(ownerCookie, "POST", `/events/${event}/results/confirm`, {
        expected: [],
      });
      expect([early.statusCode, early.json().code]).toEqual([409, "not_ended"]);
    });

    it("reveals with the owner's deadline, and the winner sees the prize everywhere", async () => {
      const { id: event, code } = await newEvent();
      const winner = await newPlayer(event, 300);
      const other = await newPlayer(event, 100);
      await owner(
        "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en, name_ar) VALUES ($1, 1, 1, 'item', 'Gold', 'ذهبية')",
        [event],
      );
      const early = await dashboard(ownerCookie, "POST", `/events/${event}/results/reveal`, {
        claimUntil: new Date(Date.now() + 24 * HOUR).toISOString(),
      });
      expect([early.statusCode, early.json().code]).toEqual([409, "not_confirmed"]);
      await dashboard(ownerCookie, "POST", `/events/${event}/results/confirm`, {
        expected: [winner.enrollment, other.enrollment],
      });
      const hidden = await asPlayer(winner.token, `/v1/events/${event}/results`);
      expect(hidden.json()).toEqual({ revealed: false, places: [], me: null });
      const soon = await dashboard(ownerCookie, "POST", `/events/${event}/results/reveal`, {
        claimUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      expect([soon.statusCode, soon.json().code]).toEqual([409, "bad_deadline"]);
      await owner(
        "UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() + interval '3 days', now() + interval '4 days')) WHERE id = $1",
        [event],
      );
      const closed = await dashboard(ownerCookie, "POST", `/events/${event}/results/reveal`, {
        claimUntil: new Date(Date.now() + 24 * HOUR).toISOString(),
      });
      expect([closed.statusCode, closed.json().code]).toEqual([409, "desk_closed_until_deadline"]);
      const editor = await dashboard(editorCookie, "POST", `/events/${event}/results/reveal`, {
        claimUntil: new Date(Date.now() + 96 * HOUR).toISOString(),
      });
      expect(editor.statusCode).toBe(403);
      const claim = new Date(Date.now() + 96 * HOUR);
      expect((await asPlayer(winner.token, `/v1/events/${event}/home`)).json()).toMatchObject({
        win: null,
        finale: null,
      });
      const revealed = await dashboard(ownerCookie, "POST", `/events/${event}/results/reveal`, {
        claimUntil: claim.toISOString(),
      });
      expect(revealed.json()).toMatchObject({
        state: "revealed",
        claimUntil: claim.toISOString(),
        places: [
          { rank: 1, prizeStatus: "reserved" },
          { rank: 2, prizeStatus: null },
        ],
      });

      const results = await asPlayer(winner.token, `/v1/events/${event}/results`);
      expect(results.json()).toMatchObject({
        revealed: true,
        places: [
          { rank: 1, score: 300, prize: { kind: "item", name: { en: "Gold" } }, mine: true },
          { rank: 2, prize: null, mine: false },
        ],
        me: {
          rank: 1,
          prize: { name: { ar: "ذهبية" } },
          status: "reserved",
          claimUntil: claim.toISOString(),
        },
      });
      const theirs = await asPlayer(other.token, `/v1/events/${event}/results`);
      expect(theirs.json()).toMatchObject({ revealed: true, me: null });

      const home = await asPlayer(winner.token, `/v1/events/${event}/home`);
      expect(home.json()).toMatchObject({
        win: { rank: 1, prize: { name: { en: "Gold" } }, status: "reserved" },
      });
      const otherHome = await asPlayer(other.token, `/v1/events/${event}/home`);
      expect(otherHome.json()).toMatchObject({ win: null, finale: { place: 2 } });
      expect(home.json()).toMatchObject({ finale: { place: 1 } });

      const shop = await asPlayer(winner.token, `/v1/events/${event}/shop`);
      const redemption = shop.json<{ redemptions: { id: string; rank: number; price: number }[] }>()
        .redemptions[0];
      expect(redemption).toMatchObject({ rank: 1, price: 0, rewardId: null, name: { en: "Gold" } });
      const cancel = await asPlayer(
        winner.token,
        `/v1/redemptions/${redemption?.id}/cancel`,
        "POST",
      );
      expect([cancel.statusCode, cancel.json().code]).toEqual([409, "rank_prize"]);

      const rules = await test.app.inject({
        method: "GET",
        url: `/v1/public/events/${code}/rules`,
      });
      expect(rules.statusCode).toBe(200);
      const block = rules.json<{ rules: { block: { en: string[] } } }>().rules.block.en;
      expect(block[0]).toContain("Najd Events");
      expect(block.at(-1)).toContain("by ");
    });
  });

  describe("rules", () => {
    it("answers the member's rules and the public page, and 404 where there are none or the event is hidden", async () => {
      const { id: event, code } = await newEvent("live");
      const member = await newPlayer(event, 10);
      const none = await asPlayer(member.token, `/v1/events/${event}/rules`);
      expect(none.statusCode).toBe(404);
      const publicNone = await test.app.inject({
        method: "GET",
        url: `/v1/public/events/${code}/rules`,
      });
      expect(publicNone.statusCode).toBe(404);

      await owner("UPDATE event SET rules_ar = 'العب بنزاهة.' WHERE id = $1", [event]);
      const textOnly = await asPlayer(member.token, `/v1/events/${event}/rules`);
      expect(textOnly.json()).toEqual({
        rules: { block: null, text: { ar: "العب بنزاهة.", en: null } },
      });
      await owner(
        "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 1, 2, 'experience', 'Tour')",
        [event],
      );
      const full = await asPlayer(member.token, `/v1/events/${event}/rules`);
      expect(full.json<{ rules: { block: { en: string[] } } }>().rules.block.en).toContain(
        "Ranks 1 to 2: Tour",
      );

      const stranger = await newPlayer((await newEvent("live")).id, 1);
      expect((await asPlayer(stranger.token, `/v1/events/${event}/rules`)).statusCode).toBe(404);

      const draft = await newEvent("draft");
      await owner("UPDATE event SET rules_en = 'Hidden' WHERE id = $1", [draft.id]);
      expect(
        (await test.app.inject({ method: "GET", url: `/v1/public/events/${draft.code}/rules` }))
          .statusCode,
      ).toBe(404);
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event]);
      expect(
        (await test.app.inject({ method: "GET", url: `/v1/public/events/${code}/rules` }))
          .statusCode,
      ).toBe(404);
    });
  });
});
