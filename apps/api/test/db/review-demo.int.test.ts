import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { sqlstate } from "#test/support/push";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL, connectAsOwner } from "#test/support/test-db";

const sha = (value: string): Buffer => createHash("sha256").update(value).digest();
/** Stand-ins for the API's keyed hashes: any fixed 32 bytes per input. */
const keyOf = (phone: string) => sha(`key:${phone}`);
const fpOf = (phone: string) => sha(`fp:${phone}`);
const fixed = (code: string) => sha(`reviewer:${code}`);
const REVIEWER = "+966500000710";
const FEATURES = ["agenda", "boosts", "cheers", "shop"];

type SignIn = { outcome: string; attempts_left: number; player_id: string | null };
type Demo = Record<string, unknown> & { exists: boolean };

/**
 * The App Review demo in the database (T-710, migration 0144, ADR-560 to ADR-567): the console doors, the fixed code in
 * the sign-in and deletion functions (only the reviewer account, only while the window is open, never on any other
 * number), the lock order against Close, the reviewer number never held by a real account, confinement both ways,
 * the event that stays live, the tick, and the Questify-wide lists that leave demo accounts out. One demo per database,
 * so the cases run in order.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("review demo (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};
  let adminId = "";
  let counter = 0;

  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('rd@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    adminId = row?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
  });
  afterAll(async () => {
    await f.close();
  });

  const demo = async (): Promise<Demo> =>
    (await f.run<{ r: Demo }>(admin, "SELECT console_review_demo() AS r"))[0]?.r ?? {
      exists: false,
    };
  const row = async () =>
    (
      await f.owner<{
        player_id: string | null;
        event_id: string;
        organizer_id: string;
        window_until: Date | null;
      }>("SELECT player_id, event_id, organizer_id, window_until FROM review_demo")
    )[0];
  const create = (phone = REVIEWER, context = admin) =>
    f.run(context, "SELECT console_review_demo_create($1, $2, $3, $4, $5) AS r", [
      phone,
      keyOf(phone),
      fpOf(phone),
      FEATURES,
      randomUUID(),
    ]);
  const prepare = (code: string, options: { days?: number; phone?: string } = {}) => {
    const phone = options.phone ?? REVIEWER;
    return f.run(admin, "SELECT console_review_demo_prepare($1, $2, $3, $4, $5, $6, $7) AS r", [
      phone,
      keyOf(phone),
      fpOf(phone),
      fixed(code),
      options.days ?? 14,
      "1.4.0",
      randomUUID(),
    ]);
  };
  const close = () => f.run(admin, "SELECT console_review_demo_close($1) AS r", [randomUUID()]);

  /** A sign-in challenge as the API opens it; its own random code hash and whether it is a reviewer one. */
  const challenge = async (phone: string) => {
    const token = randomBytes(32);
    const code = randomBytes(32);
    const [opened] = await f.run<{ reviewer: boolean }>(
      {},
      "SELECT start_player_challenge($1, $2, 'phone', $3, $4, $5, '0.1', '0.1', $6) AS reviewer",
      [randomUUID(), token, phone, keyOf(phone), code, fpOf(phone)],
    );
    return { token, code, reviewer: opened?.reviewer === true };
  };
  const signIn = async (
    c: { token: Buffer; code: Buffer },
    typed: string,
    access = randomBytes(32),
    signup = randomBytes(32),
  ): Promise<SignIn | undefined> =>
    (
      await f.run<SignIn>({}, "SELECT * FROM sign_in_player($1, $2, $3, $4, $5, $6, $7)", [
        c.token,
        randomBytes(32),
        access,
        randomBytes(32),
        randomUUID(),
        signup,
        fixed(typed),
      ])
    )[0];
  const phonePlayer = async (phone: string): Promise<string> => {
    counter += 1;
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`rd_real_${counter}`],
    );
    await f.owner("INSERT INTO player_contact (player_id, phone_e164) VALUES ($1, $2)", [
      made?.id,
      phone,
    ]);
    return made?.id ?? "";
  };
  const audits = (action: string) =>
    f.owner<{ after: unknown; target_id: string }>(
      "SELECT after, target_id FROM audit_log WHERE action = $1 ORDER BY id",
      [action],
    );
  const liveSessions = async (player: string) =>
    Number(
      (
        await f.owner<{ n: string }>(
          "SELECT count(*) AS n FROM player_session WHERE player_id = $1 AND revoked_at IS NULL",
          [player],
        )
      )[0]?.n,
    );

  const startDeletion = async (phone: string) => {
    const token = randomBytes(32);
    const [opened] = await f.run<{ known: boolean; reviewer: boolean }>(
      {},
      "SELECT * FROM start_deletion_challenge($1, $2, 'phone', $3, $4, $5)",
      [randomUUID(), token, phone, keyOf(phone), randomBytes(32)],
    );
    return { token, ...opened };
  };
  const verify = (token: Buffer, typed: string) =>
    f.run<{ outcome: string }>({}, "SELECT outcome FROM verify_deletion_code($1, $2, $3, $4)", [
      token,
      randomBytes(32),
      randomBytes(32),
      fixed(typed),
    ]);

  describe("before Create", () => {
    it("refuses every door to anyone but an active platform admin", async () => {
      for (const seat of [{}, f.team(), { playerId: f.ids.playerA }, { isAdmin: true }]) {
        expect(await sqlstate(f.run(seat, "SELECT console_review_demo()"))).toBe("QE403");
        expect(await sqlstate(create(REVIEWER, seat))).toBe("QE403");
        expect(
          await sqlstate(f.run(seat, "SELECT console_review_demo_close($1)", [randomUUID()])),
        ).toBe("QE403");
      }
      expect(await demo()).toEqual({ exists: false });
    });

    it("refuses a malformed phone and a phone a real account holds, and answers 404 doors with no demo", async () => {
      expect(await sqlstate(create("+15551234567"))).toBe("RD400");
      await phonePlayer("+966500000999");
      expect(await sqlstate(create("+966500000999"))).toBe("RD409");
      expect(await sqlstate(close())).toBe("RD404");
      expect(await sqlstate(prepare("111111"))).toBe("RD404");
    });

    it("treats the reviewer phone as any number before a window: no reviewer challenge", async () => {
      expect((await challenge(REVIEWER)).reviewer).toBe(false);
    });
  });

  describe("Create", () => {
    it("makes the organizer, the live event, 12 fictional players and the reviewer, and cancels the number's codes", async () => {
      const atSignup = await challenge(REVIEWER);
      await f.owner(
        "UPDATE player_login_challenge SET signup_hash = $1, signup_expires_at = now() + interval '15 minutes' WHERE token_hash = $2",
        [sha("signup"), atSignup.token],
      );

      const made = (await create())[0]?.["r"] as Demo;
      expect(made).toMatchObject({ exists: true, contact: REVIEWER, fictionalPlayers: 12 });
      expect(
        await f.owner(
          "SELECT cancelled_at IS NOT NULL AS cancelled FROM player_login_challenge WHERE token_hash = $1",
          [atSignup.token],
        ),
      ).toEqual([{ cancelled: true }]);
      const r = await row();
      const [event] = await f.owner<{ status: string; access: string; join_methods: string[] }>(
        "SELECT status, access, join_methods FROM event WHERE id = $1",
        [r?.event_id],
      );
      expect(event).toEqual({
        status: "live",
        access: "public",
        join_methods: ["code", "qr", "link"],
      });
      expect(
        await f.owner(
          "SELECT feature, enabled FROM organizer_feature_override WHERE organizer_id = $1 ORDER BY feature",
          [r?.organizer_id],
        ),
      ).toEqual(FEATURES.map((feature) => ({ feature, enabled: true })));
      expect(
        await f.owner(
          "SELECT can_play FROM staff_assignment WHERE player_id = $1 AND event_id = $2",
          [r?.player_id, r?.event_id],
        ),
      ).toEqual([{ can_play: true }]);
      const scores = await f.owner<{ score: string }>(
        "SELECT n.score FROM enrollment n JOIN review_demo_player d ON d.player_id = n.player_id WHERE d.role = 'fictional' ORDER BY n.score DESC",
      );
      expect(scores.map((s) => Number(s.score))).toEqual(
        Array.from({ length: 12 }, (_, i) => 520 - 40 * (i + 1)),
      );
      const [audit] = await audits("review_demo.create");
      expect(JSON.stringify(audit)).not.toContain("500000710");
      expect(
        await f.run<{ outcome: string }>(
          {},
          "SELECT outcome FROM create_player($1, 'demo_grab', 1990, 'falcon', $2, $3, $4)",
          [sha("signup"), randomBytes(32), randomBytes(32), randomUUID()],
        ),
      ).toEqual([{ outcome: "expired" }]);
    });

    it("refuses a second Create", async () => {
      expect(await sqlstate(create())).toBe("RD409");
    });
  });

  describe("Prepare and the fixed code", () => {
    it("checks the days, the version and that the number did not change", async () => {
      expect(await sqlstate(prepare("123456", { days: 31 }))).toBe("RD400");
      expect(await sqlstate(prepare("123456", { days: 0 }))).toBe("RD400");
      expect(await sqlstate(prepare("123456", { phone: "+966500000711" }))).toBe("RD409");
    });

    it("erases the old reviewer, provisions a new operator, opens the window, and audits no code", async () => {
      const before = (await row())?.player_id;
      await f.owner(
        "INSERT INTO erased_mark (fingerprint, event_id, kind, expires_at) VALUES ($1, $2, 'welcomed', now() + interval '1 day')",
        [fpOf(REVIEWER), (await row())?.event_id],
      );
      await prepare("424242");
      const after = await row();
      expect(after?.player_id).not.toBe(before);
      expect(after?.window_until?.getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 3600 * 1000);
      expect(await f.owner("SELECT status FROM player WHERE id = $1", [before])).toEqual([
        { status: "deleted" },
      ]);
      expect(
        await f.owner("SELECT 1 FROM erased_mark WHERE fingerprint = $1", [fpOf(REVIEWER)]),
      ).toEqual([]);
      const [audit] = await audits("review_demo.prepare");
      expect(audit?.after).toMatchObject({ version: "1.4.0" });
      expect(JSON.stringify(audit)).not.toContain(fixed("424242").toString("hex"));
    });

    it("waits for an SMS sign-in in flight before it locks the reviewer, so neither deadlocks", async () => {
      const reviewer = (await row())?.player_id;
      const plain = await challenge(REVIEWER);
      const signingIn = await connectAsOwner(f.db);
      try {
        await signingIn.query("BEGIN");
        await signingIn.query(
          "SELECT 1 FROM player_login_challenge WHERE token_hash = $1 FOR UPDATE",
          [plain.token],
        );
        const preparing = prepare("424242");
        for (let tries = 0; tries < 200; tries += 1) {
          const waiting = await f.owner(
            `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE 'SELECT console_review_demo_prepare%'`,
          );
          if (waiting.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await signingIn.query("SELECT 1 FROM player WHERE id = $1 FOR KEY SHARE", [reviewer]);
        await signingIn.query("COMMIT");
        await expect(preparing).resolves.toHaveLength(1);
      } finally {
        await signingIn.end();
      }
      expect((await row())?.player_id).not.toBe(reviewer);
    });

    it("signs in only the reviewer with the fixed code, and never answers new", async () => {
      const c = await challenge(REVIEWER);
      expect(c.reviewer).toBe(true);
      expect(await signIn(c, "000000")).toMatchObject({ outcome: "wrong", attempts_left: 2 });
      const access = randomBytes(32);
      const done = await signIn(c, "424242", access);
      expect(done).toMatchObject({ outcome: "signed_in", player_id: (await row())?.player_id });
      expect((await audits("review_demo.signed_in")).length).toBe(1);
    });

    it("never signs another number in with the fixed code", async () => {
      const real = "+966500000712";
      await phonePlayer(real);
      for (const phone of [real, "+966500000713"]) {
        const c = await challenge(phone);
        expect(c.reviewer).toBe(false);
        expect(await signIn(c, "424242")).toMatchObject({ outcome: "wrong" });
      }
    });

    it("answers expired when the window closed after the challenge opened, and wrong for a code changed under it", async () => {
      const c = await challenge(REVIEWER);
      await f.owner("UPDATE review_demo SET window_until = now() - interval '1 second'");
      expect(await signIn(c, "424242")).toMatchObject({ outcome: "expired", player_id: null });
      await f.owner("UPDATE review_demo SET window_until = now() + interval '1 day'");
      const d = await challenge(REVIEWER);
      await f.owner("UPDATE review_demo SET code_hash = $1", [fixed("999999")]);
      expect(await signIn(d, "424242")).toMatchObject({ outcome: "wrong" });
      await f.owner("UPDATE review_demo SET code_hash = $1", [fixed("424242")]);
    });

    it("provisions a fresh reviewer when the account was erased, and signs it in", async () => {
      const gone = (await row())?.player_id ?? "";
      const token = await f.deletionToken(gone);
      await f.run({}, "SELECT * FROM erase_player($1, true, $2)", [token, randomUUID()]);
      const c = await challenge(REVIEWER);
      const done = await signIn(c, "424242");
      expect(done?.outcome).toBe("signed_in");
      expect(done?.player_id).not.toBe(gone);
      expect(done?.player_id).toBe((await row())?.player_id);
    });

    it("never signs in, nor provisions over, a real account that holds the reviewer number", async () => {
      const reviewer = (await row())?.player_id ?? "";
      await f.owner(
        "UPDATE player_contact SET phone_e164 = NULL, email = 'moved@demo.test' WHERE player_id = $1",
        [reviewer],
      );
      const planted = await phonePlayer(REVIEWER);
      const c = await challenge(REVIEWER);
      expect(await signIn(c, "424242")).toMatchObject({ outcome: "expired", player_id: null });
      expect(await liveSessions(planted)).toBe(0);
      expect((await row())?.player_id).toBe(reviewer);
      expect((await audits("review_demo.owner_mismatch")).map((a) => a.target_id)).toEqual([
        planted,
      ]);
      await f.owner("DELETE FROM player_contact WHERE player_id = $1", [planted]);
      await f.owner(
        "UPDATE player_contact SET phone_e164 = $1, email = NULL WHERE player_id = $2",
        [REVIEWER, reviewer],
      );
    });

    it("never resends a reviewer challenge", async () => {
      const c = await challenge(REVIEWER);
      expect(
        await f.run({}, "SELECT reviewer FROM player_challenge_to_resend($1)", [c.token]),
      ).toEqual([{ reviewer: true }]);
    });
  });

  describe("Close and its races", () => {
    it("lets a verify that waited on Close find the window closed", async () => {
      const c = await challenge(REVIEWER);
      const result = await f.crossed(
        {
          context: admin,
          sql: "SELECT console_review_demo_close($1) AS r",
          values: [randomUUID()],
        },
        {
          context: {},
          sql: "SELECT outcome FROM sign_in_player($1, $2, $3, $4, $5, $6, $7)",
          values: [
            c.token,
            randomBytes(32),
            randomBytes(32),
            randomBytes(32),
            randomUUID(),
            randomBytes(32),
            fixed("424242"),
          ],
        },
      );
      expect(result.waited).toBe(true);
      expect(result.second).toEqual({ outcome: "expired" });
    });

    it("revokes the family a verify minted before Close", async () => {
      await prepare("515151");
      const reviewer = (await row())?.player_id ?? "";
      const c = await challenge(REVIEWER);
      const result = await f.crossed(
        {
          context: {},
          sql: "SELECT outcome FROM sign_in_player($1, $2, $3, $4, $5, $6, $7)",
          values: [
            c.token,
            randomBytes(32),
            randomBytes(32),
            randomBytes(32),
            randomUUID(),
            randomBytes(32),
            fixed("515151"),
          ],
        },
        {
          context: admin,
          sql: "SELECT console_review_demo_close($1) AS r",
          values: [randomUUID()],
        },
      );
      expect(result.waited).toBe(true);
      expect(result.first).toEqual({ outcome: "signed_in" });
      expect(await liveSessions(reviewer)).toBe(0);
    });
  });

  describe("the reviewer number is never a real account's", () => {
    it("refuses the demo account's own contact change, and answers taken to anyone moving to the number", async () => {
      await prepare("626262");
      const reviewer = (await row())?.player_id ?? "";
      expect(
        await f.run(
          { playerId: reviewer },
          "SELECT start_contact_change($1, $2, 'phone', $3, $4, $5) AS o",
          [randomUUID(), randomBytes(32), "+966500000799", randomBytes(32), randomBytes(32)],
        ),
      ).toEqual([{ o: "locked" }]);
      const other = await f.newPlayer();
      const token = randomBytes(32);
      const code = randomBytes(32);
      await f.run({ playerId: other }, "SELECT start_contact_change($1, $2, 'phone', $3, $4, $5)", [
        randomUUID(),
        sha(token.toString("hex")),
        REVIEWER,
        code,
        fpOf(REVIEWER),
      ]);
      expect(
        await f.run<{ outcome: string }>(
          { playerId: other },
          "SELECT outcome FROM confirm_contact_change(NULL, $1, $2, $3)",
          [sha(token.toString("hex")), code, randomUUID()],
        ),
      ).toEqual([{ outcome: "taken" }]);
    });

    it("moves the reviewer to a new number, closing the window and ending its sessions", async () => {
      const reviewer = (await row())?.player_id ?? "";
      const held = "+966500000714";
      await phonePlayer(held);
      expect(
        await sqlstate(
          f.run(admin, "SELECT console_review_demo_set_contact($1, $2, $3, $4)", [
            held,
            keyOf(held),
            fpOf(held),
            randomUUID(),
          ]),
        ),
      ).toBe("RD409");
      const next = "+966500000715";
      await f.run(admin, "SELECT console_review_demo_set_contact($1, $2, $3, $4)", [
        next,
        keyOf(next),
        fpOf(next),
        randomUUID(),
      ]);
      expect(
        await f.owner("SELECT phone_e164 FROM player_contact WHERE player_id = $1", [reviewer]),
      ).toEqual([{ phone_e164: next }]);
      expect((await row())?.window_until).toBeNull();
      expect(await liveSessions(reviewer)).toBe(0);
      expect((await challenge(REVIEWER)).reviewer).toBe(false);
      await f.run(admin, "SELECT console_review_demo_set_contact($1, $2, $3, $4)", [
        REVIEWER,
        keyOf(REVIEWER),
        fpOf(REVIEWER),
        randomUUID(),
      ]);
    });
  });

  describe("confinement", () => {
    it("keeps real players out of the demo event and demo accounts out of every other event", async () => {
      await prepare("737373");
      const r = await row();
      const [ev] = await f.owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [r?.event_id],
      );
      const real = await f.newPlayer();
      expect(
        await sqlstate(
          f.asPlayer(real, "SELECT * FROM join_event($1, 'code', '0.1')", [ev?.join_code]),
        ),
      ).toBe("RD404");
      expect(
        await sqlstate(
          f.asPlayer(r?.player_id ?? "", "SELECT * FROM join_event('NAJD1', 'code', '0.1')"),
        ),
      ).toBe("RD404");
      expect(
        await f.asPlayer(r?.player_id ?? "", "SELECT outcome FROM join_event($1, 'code', '0.1')", [
          ev?.join_code,
        ]),
      ).toEqual([{ outcome: "joined" }]);
      expect(
        await sqlstate(
          f.owner(
            "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
            [r?.organizer_id, r?.event_id, real],
          ),
        ),
      ).toBe("RD404");
      expect(
        await sqlstate(
          f.owner(
            "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
            [f.ids.orgA, f.ids.eventA, r?.player_id],
          ),
        ),
      ).toBe("RD404");
    });

    it("keeps the demo event live, public, unlisted and unlimited, and out of the public list", async () => {
      const ev = (await row())?.event_id;
      for (const change of [
        "status = 'ended'",
        "join_methods = ARRAY['code', 'public_list']",
        "access = 'private'",
        "player_limit_mode = 'hard', player_limit = 10",
        "ends_at = ends_at - interval '1 day'",
      ]) {
        expect(await sqlstate(f.owner(`UPDATE event SET ${change} WHERE id = $1`, [ev]))).toBe(
          "RD409",
        );
      }
      expect(await sqlstate(f.owner("DELETE FROM event WHERE id = $1", [ev]))).toBe("RD409");
      expect(
        await f.run({}, "SELECT id FROM public_events(NULL, 100) WHERE id = $1", [ev]),
      ).toEqual([]);
      expect(
        await f.owner("SELECT invitation_event_ok(e, false) AS why FROM event e WHERE e.id = $1", [
          ev,
        ]),
      ).toEqual([{ why: "not_public" }]);
    });

    it("gives demo accounts XP but never a Questify board row", async () => {
      const r = await row();
      const [joined] = await f.owner<{ id: string }>(
        "SELECT id FROM enrollment WHERE player_id = $1 AND event_id = $2",
        [r?.player_id, r?.event_id],
      );
      await f.earn(r?.event_id ?? "", joined?.id ?? "", { points: 30 });
      expect(
        await f.owner("SELECT 1 FROM xp_entry WHERE player_id = $1", [r?.player_id]),
      ).not.toEqual([]);
      expect(
        await f.owner(
          "SELECT b.player_id FROM xp_board b JOIN review_demo_player d ON d.player_id = b.player_id",
        ),
      ).toEqual([]);
    });

    it("leaves demo accounts out of every promotion pool", async () => {
      const reviewer = (await row())?.player_id;
      await f.owner("UPDATE player SET birth_year = 1980 WHERE id = $1", [reviewer]);
      await f.owner(
        "INSERT INTO marketing_state (player_id, channel, opted_in, changed_at, language) VALUES ($1, 'sms', true, now(), 'ar')",
        [reviewer],
      );
      expect(
        await f.owner("SELECT player_id FROM promo_pool('sms', NULL, NULL) WHERE player_id = $1", [
          reviewer,
        ]),
      ).toEqual([]);
    });
  });

  describe("the tick", () => {
    it("rolls the event's end ahead and closes a window past its end with the sessions ended", async () => {
      const r = await row();
      await f.owner("ALTER TABLE event DISABLE TRIGGER event_review_demo_guard");
      await f.owner("UPDATE event SET ends_at = now() + interval '10 days' WHERE id = $1", [
        r?.event_id,
      ]);
      await f.owner("ALTER TABLE event ENABLE ALWAYS TRIGGER event_review_demo_guard");
      const c = await challenge(REVIEWER);
      await signIn(c, "737373");
      await f.owner("UPDATE review_demo SET window_until = now() - interval '1 second'");
      expect(await sqlstate(f.run(admin, "SELECT review_demo_tick()"))).toBe("RD403");
      expect(await f.run({}, "SELECT review_demo_tick() AS n")).toEqual([{ n: 2 }]);
      const [ev] = await f.owner<{ ends_at: Date }>("SELECT ends_at FROM event WHERE id = $1", [
        r?.event_id,
      ]);
      expect(ev?.ends_at.getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 3600 * 1000);
      expect((await row())?.window_until).toBeNull();
      expect(await liveSessions(r?.player_id ?? "")).toBe(0);
      expect(await f.run({}, "SELECT review_demo_tick() AS n")).toEqual([{ n: 0 }]);
    });
  });

  describe("account deletion with the fixed code", () => {
    it("refuses the fixed code on a challenge opened outside a window", async () => {
      const closed = await startDeletion(REVIEWER);
      expect(closed).toMatchObject({ known: true, reviewer: false });
      expect(await verify(closed.token, "848484")).toEqual([{ outcome: "wrong" }]);
    });

    it("verifies the reviewer with the fixed code while the window is open, and only that account", async () => {
      await prepare("848484");
      const open = await startDeletion(REVIEWER);
      expect(open).toMatchObject({ known: true, reviewer: true });
      expect(await verify(open.token, "000000")).toEqual([{ outcome: "wrong" }]);
      expect(await verify(open.token, "848484")).toEqual([{ outcome: "verified" }]);
      const stale = await startDeletion(REVIEWER);
      await f.owner("UPDATE player_deletion_challenge SET player_id = $1 WHERE token_hash = $2", [
        f.ids.playerA,
        stale.token,
      ]);
      expect(await verify(stale.token, "848484")).toEqual([{ outcome: "expired" }]);
    });
  });

  it("gives the API's role no right on the tables or the internal functions", async () => {
    for (const sql of [
      "SELECT * FROM review_demo",
      "SELECT * FROM review_demo_player",
      "INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at, reviewer) VALUES (gen_random_uuid(), '\\x00', 'phone', '+966500000716', '\\x00', '\\x00', now(), true)",
      "SELECT review_demo_provision()",
      "SELECT review_demo_open('\\x00')",
    ]) {
      expect(await sqlstate(f.run({}, sql))).toBe("42501");
    }
  });
});
