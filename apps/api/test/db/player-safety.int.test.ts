import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { connectAsOwner, TEST_DATABASE_URL } from "#test/support/test-db";

type Note = { reasonCode: string; note: string };
type Outcome = { outcome: string; action_id: string | null };

const BAN: Note = { reasonCode: "cheating", note: "Scanned screenshots of station codes." };
const LIFT: Note = { reasonCode: "appeal_upheld", note: "The appeal showed a shared phone." };
const banSql = "SELECT * FROM admin_ban_player($1, $2, $3, $4)";
const liftSql = "SELECT * FROM admin_lift_ban($1, $2, $3, $4)";

/**
 * The safety tools in the database (T-705, migration 0120): the platform ban and its lift (admin doors with a reason,
 * every way in ended, rankings repaired), the wall that pays a player who is not active nothing, the batches that skip
 * a banned member, the ban against a payment in both orders, the sign-in answer of a banned account, and the word
 * lists and retired names the console edits. The guard's own membership lock is pinned by a bare ledger insert (0187).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("platform ban and word lists (database)", () => {
  let f: PushFixture;
  let admin: RequestContext = {};
  let names = 0;
  beforeAll(async () => {
    f = await pushFixture();
    admin = { isAdmin: true, staffUserId: await newAdmin("safety@questify.test") };
  });
  afterAll(async () => {
    await f.close();
  });

  async function newAdmin(email: string, status = "active", role = "admin"): Promise<string> {
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role, status)
       VALUES ($1, 'h', $3, $2) RETURNING id`,
      [email, status, role],
    );
    return row?.id ?? "";
  }
  async function player(): Promise<{ id: string; name: string; email: string }> {
    names += 1;
    const name = `safe_player_${names}`;
    const email = `safe${names}@example.test`;
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [name],
    );
    await f.owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      made?.id,
      email,
    ]);
    return { id: made?.id ?? "", name, email };
  }
  const act = async (sql: string, target: string, note: Note, context = admin) =>
    (await f.run<Outcome>(context, sql, [target, note.reasonCode, note.note, randomUUID()]))[0];
  const ban = (target: string, note: Note = BAN, context = admin) =>
    act(banSql, target, note, context);
  const lift = (target: string, note: Note = LIFT, context = admin) =>
    act(liftSql, target, note, context);
  const standing = async (target: string) =>
    (
      await f.owner<{ status: string; ban_action_id: string | null }>(
        "SELECT status, ban_action_id FROM player WHERE id = $1",
        [target],
      )
    )[0];
  const ownerOf = async (session: Buffer) =>
    (
      await f.run<{ owner: string | null }>({}, "SELECT player_session_owner($1) AS owner", [
        session,
      ])
    )[0]?.owner ?? null;
  const live = async () => {
    const event = await f.newEvent({ phase: "live" });
    return event;
  };
  const member = async (event: string) => {
    const who = await f.newPlayer();
    return { player: who, enrollment: await f.join(event, who) };
  };
  const banOwner = (target: string) =>
    f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [target]);
  const staffAward = (event: string, enrollment: string, amount = 20) =>
    f.run<{ entry_id: string }>(
      f.team(),
      "SELECT * FROM staff_award($1, $2, NULL, $3, 'Helped at the gate', $4, $5)",
      [event, enrollment, amount, randomUUID(), randomUUID()],
    );
  const bulk = (event: string, enrollments: string[]) =>
    f.run<{ awarded: number; skipped: number }>(
      f.team(),
      "SELECT awarded, skipped FROM bulk_award($1, $2, NULL, NULL, 15, 'Helped at the gate', $3, $4)",
      [event, enrollments, randomUUID(), randomUUID()],
    );
  const scoreOf = async (enrollment: string) =>
    Number(
      (
        await f.owner<{ score: string }>("SELECT score FROM enrollment WHERE id = $1", [enrollment])
      )[0]?.score,
    );

  const words = (
    search: string | null,
    language: string | null = null,
    match: string | null = null,
  ) =>
    f.one<{ words: { word: string; match: string; language: string }[]; total: number }>(
      admin,
      "SELECT console_words($1, $2, $3, NULL) AS r",
      [search, language, match],
    );
  const blocked = async (name: string) =>
    (await f.owner<{ b: boolean }>("SELECT username_blocked($1) AS b", [name]))[0]?.b;

  describe("seats", () => {
    it("refuses every admin door to anyone but an active platform admin", async () => {
      const target = await player();
      const seats: RequestContext[] = [
        {},
        { playerId: target.id },
        { organizerId: f.ids.orgA, staffUserId: f.ownerA },
        { isAdmin: true },
        { isAdmin: true, staffUserId: await newAdmin("off-safety@questify.test", "disabled") },
        { staffUserId: await newAdmin("none-safety@questify.test", "active", "none") },
      ];
      for (const seat of seats) {
        expect(await sqlstate(ban(target.id, BAN, seat))).toBe("QE403");
        expect(await sqlstate(lift(target.id, LIFT, seat))).toBe("QE403");
        for (const [sql, values] of [
          ["SELECT console_words(NULL, NULL, NULL, NULL)", []],
          ["SELECT admin_word_add('gnarl', 'word', 'en', $1)", [randomUUID()]],
          ["SELECT admin_word_remove('gnarl', $1)", [randomUUID()]],
          ["SELECT console_retired_usernames(NULL, NULL)", []],
          ["SELECT admin_unretire_username('gnarl', $1)", [randomUUID()]],
        ] as const) {
          expect(await sqlstate(f.run(seat, sql, [...values]))).toBe("QE403");
        }
      }
      expect((await standing(target.id))?.status).toBe("active");
    });

    it("leaves the API's role no way to change a standing or the ban pointer itself", async () => {
      const target = await player();
      for (const column of ["status = 'banned'", "ban_action_id = NULL"]) {
        expect(
          await sqlstate(f.run(admin, `UPDATE player SET ${column} WHERE id = $1`, [target.id])),
        ).toBe("42501");
      }
    });
  });

  describe("the ban", () => {
    it("needs a listed reason and a note, and refuses an erased or unknown account", async () => {
      const target = await player();
      expect(await sqlstate(ban(target.id, { reasonCode: "rude", note: BAN.note }))).toBe("PA400");
      expect(await sqlstate(ban(target.id, { reasonCode: "spam", note: "short" }))).toBe("PA400");
      expect(await sqlstate(lift(target.id, { reasonCode: "cheating", note: LIFT.note }))).toBe(
        "PA400",
      );
      const gone = await player();
      await f.erase(gone.id);
      expect(await sqlstate(ban(gone.id))).toBe("PA404");
      expect(await sqlstate(ban(randomUUID()))).toBe("PA404");
    });

    it("ends every way in, keeps the memberships and ledger, repairs rankings and audits ids only", async () => {
      const target = await player();
      const event = await live();
      const enrollment = await f.join(event, target.id);
      await f.earn(event, enrollment, { points: 30 });
      const sign = await f.signIn(target.id);
      await f.register(target.id, sign.session);
      await f.owner("DELETE FROM ranking_repair");
      const done = await ban(target.id);
      expect(done).toMatchObject({ outcome: "banned" });
      expect(await standing(target.id)).toEqual({
        status: "banned",
        ban_action_id: done?.action_id,
      });
      expect(await ownerOf(sign.session)).toBeNull();
      expect(await f.count("push_device WHERE player_id = $1", [target.id])).toBe(0);
      expect(
        await f.count("player_refresh WHERE player_id = $1 AND revoked_at IS NULL", [target.id]),
      ).toBe(0);
      expect(await f.count("ranking_repair WHERE event_id = $1", [event])).toBe(1);
      expect(await scoreOf(enrollment)).toBe(30);
      expect(await f.owner("SELECT status FROM enrollment WHERE id = $1", [enrollment])).toEqual([
        { status: "active" },
      ]);
      const [audit] = await f.owner<{ after: Record<string, unknown>; target_id: string }>(
        "SELECT after, target_id FROM audit_log WHERE action = 'player.ban' ORDER BY id DESC LIMIT 1",
      );
      expect(audit).toEqual({
        target_id: target.id,
        after: { actionId: done?.action_id, reasonCode: "cheating" },
      });
      expect(await ban(target.id)).toEqual({ outcome: "already_banned", action_id: null });
      expect(await f.count("player_admin_action WHERE player_id = $1", [target.id])).toBe(1);
    });

    it("answers banned with the reason only after the right code, and a lift lets the player back", async () => {
      const target = await player();
      await f.owner(
        `INSERT INTO platform_setting (key, value) VALUES ('moderation', '{"appealEmail": "appeals@questify.test"}')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      const old = await f.signIn(target.id);
      await ban(target.id, { reasonCode: "prize_fraud", note: BAN.note });
      const code = async () => {
        const token = randomBytes(32);
        const right = randomBytes(32);
        await f.owner(
          `INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at,
                                               terms_version, privacy_version, contact_fp)
           VALUES ($1, $2, 'email', $3, $4, $5, now() + interval '5 minutes', '1.0', '1.0', $6)`,
          [randomUUID(), token, target.email, randomBytes(32), right, randomBytes(32)],
        );
        return { token, right };
      };
      const signIn = (token: Buffer, typed: Buffer) =>
        f.run<{ outcome: string; player_id: string | null }>(
          {},
          "SELECT outcome, player_id FROM sign_in_player($1, $2, $3, $4, $5, $6, sha256('not the fixed code'::bytea))",
          [token, typed, randomBytes(32), randomBytes(32), randomUUID(), randomBytes(32)],
        );
      const first = await code();
      expect((await signIn(first.token, randomBytes(32)))[0]?.outcome).toBe("wrong");
      expect(await signIn(first.token, first.right)).toEqual([
        { outcome: "banned", player_id: target.id },
      ]);
      expect(
        await f.count("player_session WHERE player_id = $1 AND revoked_at IS NULL", [target.id]),
      ).toBe(0);
      expect(
        await f.run({}, "SELECT reason, appeal_email FROM ban_notice($1)", [target.id]),
      ).toEqual([{ reason: "prize_fraud", appeal_email: "appeals@questify.test" }]);

      expect(await lift(target.id)).toMatchObject({ outcome: "lifted" });
      expect(await standing(target.id)).toEqual({ status: "active", ban_action_id: null });
      expect(await ownerOf(old.session)).toBeNull();
      expect(await f.run({}, "SELECT reason FROM ban_notice($1)", [target.id])).toEqual([
        { reason: null },
      ]);
      const second = await code();
      expect((await signIn(second.token, second.right))[0]?.outcome).toBe("signed_in");
      expect(await lift(target.id)).toEqual({ outcome: "not_banned", action_id: null });
      expect(
        await f.owner(
          "SELECT kind FROM player_admin_action WHERE player_id = $1 ORDER BY created_at",
          [target.id],
        ),
      ).toEqual([{ kind: "ban" }, { kind: "lift_ban" }]);
    });

    it("refuses what a sign-in that held its code before the ban issued", async () => {
      const target = await player();
      const token = randomBytes(32);
      const code = randomBytes(32);
      await f.owner(
        `INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at,
                                             terms_version, privacy_version, contact_fp)
         VALUES ($1, $2, 'email', $3, $4, $5, now() + interval '5 minutes', '1.0', '1.0', $6)`,
        [randomUUID(), token, target.email, randomBytes(32), code, randomBytes(32)],
      );
      const access = randomBytes(32);
      const result = await f.crossed(
        {
          context: {},
          sql: "SELECT outcome FROM sign_in_player($1, $2, $3, $4, $5, $6, sha256('not the fixed code'::bytea))",
          values: [token, code, access, randomBytes(32), randomUUID(), randomBytes(32)],
        },
        {
          context: admin,
          sql: banSql,
          values: [target.id, BAN.reasonCode, BAN.note, randomUUID()],
        },
      );
      expect(result.waited).toBe(true);
      expect(result.first).toEqual({ outcome: "signed_in" });
      expect(result.second).toMatchObject({ outcome: "banned" });
      expect(await ownerOf(access)).toBeNull();
    });

    it("is the only writer of a banned standing: no other function or trigger sets it", async () => {
      const writers = await f.owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.prosrc ~* 'UPDATE\\s+player\\s+SET[^;]*status\\s*=\\s*''banned'''
         ORDER BY 1`,
      );
      expect(writers).toEqual([{ proname: "admin_ban_player" }]);
      const lifts = await f.owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.prosrc ~* 'UPDATE\\s+player\\s+SET[^;]*status\\s*=\\s*''active'''
         ORDER BY 1`,
      );
      expect(lifts).toEqual([{ proname: "admin_lift_ban" }]);
    });

    it("lets a banned account be erased: the pointer is cleared before its action rows go", async () => {
      const target = await player();
      await ban(target.id);
      expect(await f.erase(target.id)).toBe("erased");
      expect(await standing(target.id)).toEqual({ status: "deleted", ban_action_id: null });
      expect(await f.count("player_admin_action WHERE player_id = $1", [target.id])).toBe(0);
    });
  });

  describe("the wall", () => {
    it("pays no points or XP to a banned or erased player; refunds and removals pass", async () => {
      const event = await live();
      const paid = await member(event);
      const cut = await member(event);
      const entry = await f.earn(event, cut.enrollment, { points: 40 });
      await banOwner(cut.player);
      expect(await sqlstate(f.earn(event, cut.enrollment))).toBe("PB423");
      expect(await sqlstate(staffAward(event, cut.enrollment))).toBe("PB423");
      expect(
        await sqlstate(
          f.owner(
            "INSERT INTO xp_entry (player_id, delta, source, achievement_id, tier) VALUES ($1, 5, 'achievement', 'top-ten', 'gold')",
            [cut.player],
          ),
        ),
      ).toBe("PB423");
      await f.removeEntry(event, entry);
      expect(await scoreOf(cut.enrollment)).toBe(0);
      expect(await f.count("xp_entry WHERE player_id = $1 AND delta < 0", [cut.player])).toBe(1);

      await staffAward(event, paid.enrollment);
      expect(await scoreOf(paid.enrollment)).toBe(20);

      const gone = await member(event);
      await f.erase(gone.player);
      expect(
        await sqlstate(
          f.owner(
            `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                       staff_user_id)
             VALUES ($1, $2, $3, 'award', 5, 5, 'staff', $4)`,
            [f.ids.orgA, event, gone.enrollment, f.ownerA],
          ),
        ),
      ).toBe("PB423");
    });

    it("skips a banned member in a bulk award and pays every other", async () => {
      const event = await live();
      const members = [await member(event), await member(event), await member(event)];
      await banOwner(members[1]?.player ?? "");
      expect(
        await bulk(
          event,
          members.map((m) => m.enrollment),
        ),
      ).toEqual([{ awarded: 2, skipped: 1 }]);
      expect(await Promise.all(members.map((m) => scoreOf(m.enrollment)))).toEqual([15, 0, 15]);
    });

    it("skips a banned member's raise in a past points change and still applies a lowering", async () => {
      const event = await live();
      const [quest] = await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, position, visible)
         SELECT $1, id, 'enter_code', 'Stage', 100, 1, '{"code": "ABC"}', 1, true FROM category WHERE event_id = $1
         LIMIT 1 RETURNING id`,
        [event],
      );
      const [kept, cut] = [await member(event), await member(event)];
      for (const who of [kept, cut]) {
        await f.asPlayer(
          who.player,
          "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
          [quest?.id, randomUUID()],
        );
      }
      await banOwner(cut.player);
      const past = async (points: number, from: number) => {
        await f.owner("UPDATE quest SET points = $2 WHERE id = $1", [quest?.id, points]);
        return (
          await f.run<{ players: number }>(
            f.team(),
            "SELECT players FROM apply_past_points($1, $2, $3, $4, $5)",
            [event, quest?.id, from, randomUUID(), randomUUID()],
          )
        )[0];
      };
      expect(await past(150, 100)).toEqual({ players: 1 });
      expect([await scoreOf(kept.enrollment), await scoreOf(cut.enrollment)]).toEqual([150, 100]);
      expect(await past(60, 150)).toEqual({ players: 2 });
      expect([await scoreOf(kept.enrollment), await scoreOf(cut.enrollment)]).toEqual([60, 60]);
    });

    it("runs a ban and a payment one after the other, in both orders", async () => {
      const event = await live();
      const first = await member(event);
      const paidFirst = await f.crossed(
        {
          context: f.team(),
          sql: "SELECT * FROM staff_award($1, $2, NULL, 20, 'Helped at the gate', $3, $4)",
          values: [event, first.enrollment, randomUUID(), randomUUID()],
        },
        {
          context: admin,
          sql: banSql,
          values: [first.player, BAN.reasonCode, BAN.note, randomUUID()],
        },
      );
      expect(paidFirst.waited).toBe(true);
      expect(paidFirst.second).toMatchObject({ outcome: "banned" });
      expect(await scoreOf(first.enrollment)).toBe(20);

      const second = await member(event);
      const bannedFirst = await f.crossed(
        {
          context: admin,
          sql: banSql,
          values: [second.player, BAN.reasonCode, BAN.note, randomUUID()],
        },
        {
          context: f.team(),
          sql: "SELECT awarded, skipped FROM bulk_award($1, $2, NULL, NULL, 15, 'Helped at the gate', $3, $4)",
          values: [event, [second.enrollment], randomUUID(), randomUUID()],
        },
      );
      expect(bannedFirst.waited).toBe(true);
      expect(bannedFirst.second).toEqual({ awarded: 0, skipped: 1 });
      expect(await scoreOf(second.enrollment)).toBe(0);

      const third = await member(event);
      const guarded = await f.crossed(
        {
          context: admin,
          sql: banSql,
          values: [third.player, BAN.reasonCode, BAN.note, randomUUID()],
        },
        {
          context: f.team(),
          sql: "SELECT * FROM staff_award($1, $2, NULL, 20, 'Helped at the gate', $3, $4)",
          values: [event, third.enrollment, randomUUID(), randomUUID()],
        },
      );
      expect(guarded.waited).toBe(true);
      expect(guarded.second).toMatchObject({ code: "PB423" });
      expect(await scoreOf(third.enrollment)).toBe(0);
    });

    it("makes a ledger row whose writer took no membership lock wait on the ban, then refuses it", async () => {
      // staff_award locks the membership itself, so only a bare insert pins the guard's own FOR NO KEY UPDATE.
      const event = await live();
      const who = await member(event);
      const banner = await connectAsOwner(f.db);
      const payer = await connectAsOwner(f.db);
      let paid: Promise<string> | undefined;
      try {
        await banner.query("BEGIN");
        await banner.query(
          "SELECT set_config('app.is_admin', 'on', true), set_config('app.staff_user_id', $1, true)",
          [admin.staffUserId],
        );
        await banner.query(banSql, [who.player, BAN.reasonCode, BAN.note, randomUUID()]);
        const pid = (await payer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        paid = sqlstate(
          payer.query(
            `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                       staff_user_id)
             VALUES ($1, $2, $3, 'award', 5, 5, 'staff', $4)`,
            [f.ids.orgA, event, who.enrollment, f.ownerA],
          ),
        );
        let waited = false;
        for (let attempt = 0; attempt < 200 && !waited; attempt += 1) {
          waited =
            (
              await f.owner(
                "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
                [pid],
              )
            ).length === 1;
          if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await banner.query("COMMIT");
        expect(waited).toBe(true);
        expect(await paid).toBe("PB423");
      } finally {
        await banner.query("ROLLBACK");
        await paid;
        await Promise.all([banner.end(), payer.end()]);
      }
      expect(await scoreOf(who.enrollment)).toBe(0);
      expect((await standing(who.player))?.status).toBe("banned");
    });
  });

  describe("word lists and retired names", () => {
    it("adds and removes a word, which sign-up and rename read at once", async () => {
      expect(await blocked("the_gnarlix_king")).toBe(false);
      expect(
        await f.one(admin, "SELECT admin_word_add('  GNARLIX ', 'part', 'en', $1) AS r", [
          randomUUID(),
        ]),
      ).toBe("added");
      expect(
        await f.one(admin, "SELECT admin_word_add('gnarlix', 'word', 'en', $1) AS r", [
          randomUUID(),
        ]),
      ).toBe("exists");
      expect(await blocked("the_gnarlix_king")).toBe(true);
      expect(await words("narli", "en", "part")).toEqual({
        words: [expect.objectContaining({ word: "gnarlix", match: "part", language: "en" })],
        total: 1,
      });
      expect((await words("narli", "ar")).total).toBe(0);
      const target = await player();
      expect(
        await f.asPlayer<{ outcome: string }>(
          target.id,
          "SELECT * FROM rename_player('gnarlix_fan', 1)",
        ),
      ).toMatchObject([{ outcome: "username_blocked" }]);
      expect(
        await f.one(admin, "SELECT admin_word_remove('Gnarlix', $1) AS r", [randomUUID()]),
      ).toBe("removed");
      expect(
        await f.one(admin, "SELECT admin_word_remove('gnarlix', $1) AS r", [randomUUID()]),
      ).toBe("not_found");
      expect(await blocked("the_gnarlix_king")).toBe(false);
      expect(
        await f.owner<{ action: string; target_id: string }>(
          "SELECT action, target_id FROM audit_log WHERE action LIKE 'username_word.%' ORDER BY id",
        ),
      ).toEqual([
        { action: "username_word.add", target_id: "gnarlix" },
        { action: "username_word.remove", target_id: "gnarlix" },
      ]);
    });

    it("refuses what cannot be a list word", async () => {
      for (const [word, match, language] of [
        ["ab1", "word", "en"],
        ["a", "word", "en"],
        ["gnarl", "whole", "en"],
        ["gnarl", "word", "fr"],
      ]) {
        expect(
          await sqlstate(
            f.run(admin, "SELECT admin_word_add($1, $2, $3, $4)", [
              word,
              match,
              language,
              randomUUID(),
            ]),
          ),
        ).toBe("WL400");
      }
    });

    it("lists and un-retires a retired name without writing it to the audit", async () => {
      await f.owner(
        "INSERT INTO username_retired (fold) VALUES ('old_rude_name') ON CONFLICT DO NOTHING",
      );
      expect(await blocked("Old_Rude_Name")).toBe(true);
      expect(
        await f.one<{ fold: string }[]>(
          admin,
          "SELECT console_retired_usernames('rude', NULL) AS r",
        ),
      ).toEqual([expect.objectContaining({ fold: "old_rude_name" })]);
      expect(
        await f.one(admin, "SELECT admin_unretire_username('OLD_rude_name', $1) AS r", [
          randomUUID(),
        ]),
      ).toBe("unretired");
      expect(
        await f.one(admin, "SELECT admin_unretire_username('old_rude_name', $1) AS r", [
          randomUUID(),
        ]),
      ).toBe("not_found");
      expect(await blocked("Old_Rude_Name")).toBe(false);
      const [audit] = await f.owner<Record<string, unknown>>(
        "SELECT target_id, before, after FROM audit_log WHERE action = 'username_retired.remove'",
      );
      expect(audit).toEqual({ target_id: null, before: null, after: null });
    });
  });
});
