import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type SearchRow = {
  id: string;
  username: string;
  status: string;
  contacts: { phone: string | null; email: string | null };
};
type Note = { reasonCode: string; note: string };

const NOTE = "Support ticket 4411, the player proved the phone.";
const REVEAL: Note = { reasonCode: "support_request", note: NOTE };
const RENAME: Note = { reasonCode: "offensive", note: "The name insults another player." };
const RESET: Note = { reasonCode: "lost_access", note: "Lost phone, verified by support." };

/**
 * The console's player tools (T-704, migration 0118): search, the read-only record and points record, the contact
 * reveal, the admin rename and the sign-in reset with its token cutoff. Every door is for an active platform admin
 * (QE403 for any other seat), takes a reason, and audits with ids only.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console player tools (database)", () => {
  let f: PushFixture;
  let adminId = "";
  let admin: RequestContext = {};
  let names = 0;
  beforeAll(async () => {
    f = await pushFixture();
    adminId = await newAdmin("players@questify.test");
    admin = { isAdmin: true, staffUserId: adminId };
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
  /** A player signed up with a name of its own and both contacts (no rename in its history). */
  async function player(
    name?: string,
  ): Promise<{ id: string; name: string; phone: string; email: string }> {
    names += 1;
    const chosen = name ?? `tool_player_${names}`;
    const phone = `+9665${String(10_000_000 + names * 7919).slice(-8)}`;
    const email = `tools${names}@example.test`;
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [chosen],
    );
    const id = made?.id ?? "";
    await f.owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      id,
      phone,
      email,
    ]);
    return { id, name: chosen, phone, email };
  }
  const search = (by: string, q: string, context = admin) =>
    f.one<SearchRow[]>(context, "SELECT console_player_search($1, $2, $3) AS r", [
      by,
      q,
      randomUUID(),
    ]);
  const record = (target: string) =>
    f.one<Record<string, unknown>>(admin, "SELECT console_player_record($1, $2) AS r", [
      target,
      randomUUID(),
    ]);
  const reveal = (target: string, note: Note = REVEAL, context = admin) =>
    f.one<{ phone: string | null; email: string | null }>(
      context,
      "SELECT console_player_contact($1, $2, $3, $4) AS r",
      [target, note.reasonCode, note.note, randomUUID()],
    );
  const rename = async (target: string, name: string, note: Note = RENAME, context = admin) =>
    (
      await f.run<{ outcome: string; action_id: string | null }>(
        context,
        "SELECT * FROM admin_rename_player($1, $2, $3, $4, $5)",
        [target, name, note.reasonCode, note.note, randomUUID()],
      )
    )[0];
  const resetSql = "SELECT * FROM admin_reset_player_sign_in($1, $2, $3, $4)";
  const reset = async (target: string, note: Note = RESET, context = admin) =>
    (
      await f.run<{ action_id: string; ended: number }>(context, resetSql, [
        target,
        note.reasonCode,
        note.note,
        randomUUID(),
      ])
    )[0];
  const audits = (action: string) =>
    f.owner<{ actor_id: string; target_id: string | null; after: Record<string, unknown> | null }>(
      "SELECT actor_id, target_id, after FROM audit_log WHERE action = $1 ORDER BY id",
      [action],
    );
  const ownerOf = async (session: Buffer) =>
    (
      await f.run<{ owner: string | null }>({}, "SELECT player_session_owner($1) AS owner", [
        session,
      ])
    )[0]?.owner ?? null;
  const rotate = async (refresh: Buffer) =>
    (
      await f.run<{ outcome: string }>({}, "SELECT * FROM rotate_player_refresh($1, $2, $3)", [
        refresh,
        randomBytes(32),
        randomBytes(32),
      ])
    )[0]?.outcome;
  /** A live sign-in code for the player's email, as start_player_challenge leaves it; its token and code hashes. */
  async function liveCode(email: string): Promise<{ token: Buffer; code: Buffer }> {
    const token = randomBytes(32);
    const code = randomBytes(32);
    await f.owner(
      `INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at,
                                           terms_version, privacy_version, contact_fp)
       VALUES ($1, $2, 'email', $3, $4, $5, now() + interval '5 minutes', '1.0', '1.0', $6)`,
      [randomUUID(), token, email, randomBytes(32), code, randomBytes(32)],
    );
    return { token, code };
  }
  const signInSql = "SELECT outcome, player_id FROM sign_in_player($1, $2, $3, $4, $5, $6)";

  describe("seats", () => {
    it("refuses every door to anyone but an active platform admin", async () => {
      const target = await player();
      const disabled = await newAdmin("disabled-players@questify.test", "disabled");
      const notAdmin = await newAdmin("member-players@questify.test", "active", "none");
      const seats: RequestContext[] = [
        {},
        f.team(),
        { playerId: target.id },
        { isAdmin: true },
        { isAdmin: true, staffUserId: disabled },
        { isAdmin: true, staffUserId: notAdmin },
        { staffUserId: adminId },
      ];
      for (const seat of seats) {
        expect(await sqlstate(search("username", "tool", seat))).toBe("QE403");
        expect(
          await sqlstate(
            f.run(seat, "SELECT console_player_record($1, $2)", [target.id, randomUUID()]),
          ),
        ).toBe("QE403");
        expect(
          await sqlstate(
            f.run(seat, "SELECT console_player_ledger($1, NULL, NULL, $2)", [
              target.id,
              randomUUID(),
            ]),
          ),
        ).toBe("QE403");
        expect(await sqlstate(reveal(target.id, REVEAL, seat))).toBe("QE403");
        expect(await sqlstate(rename(target.id, "other_name_x", RENAME, seat))).toBe("QE403");
        expect(await sqlstate(reset(target.id, RESET, seat))).toBe("QE403");
      }
      expect(await f.count("player_admin_action WHERE player_id = $1", [target.id])).toBe(0);
    });

    it("gives the API's role no access to the new tables", async () => {
      for (const table of ["player_admin_action", "username_retired"]) {
        expect(await sqlstate(f.run(admin, `SELECT * FROM ${table}`))).toBe("42501");
      }
    });
  });

  describe("search", () => {
    it("finds a folded username prefix, escapes _ and never finds a tombstone", async () => {
      const arabic = await player("أحمد_البطل");
      const plain = await player("searchme_one");
      await player("searchmeXtwo");
      const gone = await player("searchme_gone");
      await f.erase(gone.id);

      expect((await search("username", "احمد")).map((row) => row.id)).toEqual([arabic.id]);
      const underscored = await search("username", "searchme_");
      expect(underscored.map((row) => row.id)).toEqual([plain.id]);
      expect((await search("username", "SEARCHME")).map((row) => row.username)).toEqual([
        "searchme_one",
        "searchmeXtwo",
      ]);
      expect(underscored[0]?.contacts).toEqual({
        phone: `${plain.phone.slice(0, 5)}•••••${plain.phone.slice(-2)}`,
        email: "t•••@example.test",
      });
    });

    it("matches a phone or an email exactly, never as a pattern", async () => {
      const target = await player();
      expect((await search("phone", target.phone)).map((row) => row.id)).toEqual([target.id]);
      expect((await search("email", target.email.toUpperCase())).map((row) => row.id)).toEqual([
        target.id,
      ]);
      expect(await search("email", "%@example.test")).toEqual([]);
      expect(await search("email", target.email.slice(0, -1))).toEqual([]);
      expect(await sqlstate(search("phone", "+9665%"))).toBe("PA400");
    });

    it("refuses a short or unknown search and audits how, how many and which ids, never the text", async () => {
      const target = await player("audit_search_me");
      expect(await sqlstate(search("username", "ab"))).toBe("PA400");
      expect(await sqlstate(search("birth_year", "1990"))).toBe("PA400");
      await search("email", target.email);
      const entry = (await audits("console.players_search")).at(-1);
      expect(entry?.actor_id).toBe(adminId);
      expect(entry?.after).toEqual({ by: "email", count: 1, playerIds: [target.id] });
      expect(JSON.stringify(await audits("console.players_search"))).not.toContain(target.email);
    });
  });

  describe("the record", () => {
    it("shows every section read-only, masked, and audits each look", async () => {
      const target = await player("record_subject");
      const event = await f.newEvent();
      const enrollment = await f.join(event, target.id);
      await f.earn(event, enrollment, { points: 40 });
      await f.owner(
        `INSERT INTO audit_log (actor_type, action, target_type, target_id, after)
         VALUES ('system', 'player.contact_change', 'player', $1, '{"channel":"phone","kind":"replaced"}')`,
        [target.id],
      );
      await f.signIn(target.id);
      const before = (await audits("console.player_read")).length;
      const answer = await record(target.id);

      expect(answer["player"]).toMatchObject({
        id: target.id,
        username: "record_subject",
        status: "active",
      });
      expect(answer["contacts"]).toEqual({
        phone: `${target.phone.slice(0, 5)}•••••${target.phone.slice(-2)}`,
        email: "t•••@example.test",
      });
      expect(answer["contactsChanged"]).toMatchObject({ channel: "phone", kind: "replaced" });
      expect(answer["events"]).toEqual([
        expect.objectContaining({ eventId: event, status: "active", score: 40, excluded: false }),
      ]);
      expect(answer["sessions"]).toBe(1);
      expect(answer["flags"]).toEqual([]);
      expect(answer["reports"]).toEqual([]);
      expect(JSON.stringify(answer)).not.toContain(target.email);
      expect(JSON.stringify(answer)).not.toContain(target.phone);
      const entries = await audits("console.player_read");
      expect(entries.length).toBe(before + 1);
      expect(entries.at(-1)).toMatchObject({
        actor_id: adminId,
        target_id: target.id,
        after: null,
      });
    });

    it("answers an erased account with its id and dates only, and an unknown id with PA404", async () => {
      const gone = await player();
      await f.erase(gone.id);
      const answer = await record(gone.id);
      expect(Object.keys(answer)).toEqual(["player", "legalRequests"]);
      expect(answer["player"]).toMatchObject({ id: gone.id, status: "deleted" });
      expect(await sqlstate(record(randomUUID()))).toBe("PA404");
    });

    it("pages the points record newest first, by event, audited per page", async () => {
      const target = await player();
      const first = await f.newEvent();
      const second = await f.newEvent();
      const one = await f.join(first, target.id);
      const two = await f.join(second, target.id);
      for (let i = 0; i < 52; i += 1) {
        await f.earn(first, one, { points: 1 });
      }
      await f.earn(second, two, { points: 5 });
      const page = (before: number | null, event: string | null = null) =>
        f.one<{ id: number; eventId: string; kind: string; actor: string }[]>(
          admin,
          "SELECT console_player_ledger($1, $2, $3, $4) AS r",
          [target.id, event, before, randomUUID()],
        );
      const top = await page(null);
      expect(top).toHaveLength(50);
      expect(top[0]?.eventId).toBe(second);
      const rest = await page(top.at(-1)?.id ?? 0);
      expect(rest).toHaveLength(3);
      expect((await page(null, second)).map((line) => line.kind)).toEqual(["quest"]);
      expect((await audits("console.player_ledger_read")).at(-1)?.after).toEqual({
        eventId: second,
        count: 1,
      });
    });
  });

  describe("contact reveal", () => {
    it("needs a known reason code and a clean note of 10 to 300 characters", async () => {
      const target = await player();
      for (const bad of [
        { reasonCode: "curious", note: NOTE },
        { reasonCode: "support_request", note: "too short" },
        { reasonCode: "support_request", note: `${"x".repeat(301)}` },
        { reasonCode: "support_request", note: "Ticket 12\u202E reversed text" },
        { reasonCode: "offensive", note: NOTE },
      ]) {
        expect(await sqlstate(reveal(target.id, bad))).toBe("PA400");
      }
      expect(await f.count("player_admin_action WHERE player_id = $1", [target.id])).toBe(0);
    });

    it("answers the full contacts with an action row and an audit entry on every call", async () => {
      const target = await player();
      expect(await reveal(target.id)).toEqual({ phone: target.phone, email: target.email });
      await reveal(target.id);
      const rows = await f.owner<{ kind: string; reason_code: string; note: string }>(
        "SELECT kind, reason_code, note FROM player_admin_action WHERE player_id = $1",
        [target.id],
      );
      expect(rows).toEqual([
        { kind: "contact_reveal", reason_code: "support_request", note: NOTE },
        { kind: "contact_reveal", reason_code: "support_request", note: NOTE },
      ]);
      const entries = (await audits("console.player_contact_read")).filter(
        (entry) => entry.target_id === target.id,
      );
      expect(entries).toHaveLength(2);
      expect(JSON.stringify(entries)).not.toContain(target.email);
      expect(JSON.stringify(entries)).not.toContain(NOTE);
    });
  });

  describe("admin rename", () => {
    it("renames, retires the old name, records `admin`, tells the player and leaves the window unused", async () => {
      const target = await player("rude_name_one");
      const done = await rename(target.id, "fresh_name_one");
      expect(done?.outcome).toBe("renamed");
      expect(await f.usernameOf(target.id)).toBe("fresh_name_one");
      const history = await f.owner<{ username: string; reason: string }>(
        "SELECT username, reason FROM username_history WHERE player_id = $1 ORDER BY id",
        [target.id],
      );
      expect(history.at(-1)).toEqual({ username: "fresh_name_one", reason: "admin" });
      expect(await f.count("username_retired WHERE fold = 'rude_name_one'")).toBe(1);
      expect(
        await f.owner(
          "SELECT kind, from_username, to_username FROM player_admin_action WHERE id = $1",
          [done?.action_id],
        ),
      ).toEqual([
        { kind: "rename", from_username: "rude_name_one", to_username: "fresh_name_one" },
      ]);
      expect(
        await f.count("notice WHERE kind = 'username_changed' AND player_id = $1", [target.id]),
      ).toBe(1);
      const entry = (await audits("player.admin_rename")).at(-1);
      expect(entry?.after).toEqual({ actionId: done?.action_id, reasonCode: "offensive" });
      expect(JSON.stringify(entry)).not.toContain("rude_name_one");

      const [own] = await f.asPlayer<{ outcome: string }>(
        target.id,
        "SELECT outcome FROM rename_player($1, 30)",
        ["players_choice_1"],
      );
      expect(own?.outcome).toBe("renamed");
    });

    it("retires nothing when the old name held personal data, and calls a case-only change unchanged", async () => {
      const target = await player("ali_0555_private");
      const same = await rename(target.id, "ALI_0555_PRIVATE");
      expect(same).toEqual({ outcome: "unchanged", action_id: null });
      const done = await rename(target.id, "masked_name_1", {
        reasonCode: "personal_data",
        note: "Phone number in the name",
      });
      expect(done?.outcome).toBe("renamed");
      expect(await f.count("username_retired WHERE fold = 'ali_0555_private'")).toBe(0);
    });

    it("keeps the retired name from everyone, the renamed player included", async () => {
      const target = await player("retire_me_now");
      await rename(target.id, "retired_after_1");
      const other = await player();
      for (const who of [other.id, target.id]) {
        const [own] = await f.asPlayer<{ outcome: string }>(
          who,
          "SELECT outcome FROM rename_player($1, 1)",
          ["RETIRE_me_now"],
        );
        expect(own?.outcome).toBe("username_blocked");
      }
      expect((await rename(other.id, "retire_me_now"))?.outcome).toBe("username_blocked");
    });

    it("answers taken, blocked, unchanged and invalid without writing anything", async () => {
      const target = await player("calm_name_two");
      const taken = await player("taken_name_two");
      await f.owner(
        "INSERT INTO username_word (word, match, language) VALUES ('badword', 'part', 'en')",
      );
      expect((await rename(target.id, "TAKEN_name_two"))?.outcome).toBe("username_taken");
      expect((await rename(target.id, "my_badword_9"))?.outcome).toBe("username_blocked");
      expect((await rename(target.id, "calm_name_two"))?.outcome).toBe("unchanged");
      expect((await rename(target.id, "bad name!"))?.outcome).toBe("invalid");
      expect(await f.usernameOf(target.id)).toBe("calm_name_two");
      expect(await f.usernameOf(taken.id)).toBe("taken_name_two");
      expect(await f.count("player_admin_action WHERE player_id = $1", [target.id])).toBe(0);
    });

    it("refuses a tombstone and an unknown id with PA404 and a bad reason with PA400", async () => {
      const gone = await player();
      await f.erase(gone.id);
      expect(await sqlstate(rename(gone.id, "back_from_dead"))).toBe("PA404");
      expect(await sqlstate(rename(randomUUID(), "nobody_at_all"))).toBe("PA404");
      const target = await player();
      expect(
        await sqlstate(rename(target.id, "x_name_ok", { ...RENAME, reasonCode: "lost_access" })),
      ).toBe("PA400");
    });

    it("runs after a player's own rename that holds the row, not beside it", async () => {
      const target = await player("race_name_one");
      const result = await f.crossed(
        {
          context: { playerId: target.id },
          sql: "SELECT outcome FROM rename_player($1, 1)",
          values: ["race_by_player"],
        },
        {
          context: admin,
          sql: "SELECT outcome FROM admin_rename_player($1, $2, $3, $4, $5)",
          values: [target.id, "race_by_admin", RENAME.reasonCode, RENAME.note, randomUUID()],
        },
      );
      expect(result.waited).toBe(true);
      expect(result.first).toEqual({ outcome: "renamed" });
      expect(result.second).toEqual({ outcome: "renamed" });
      expect(await f.usernameOf(target.id)).toBe("race_by_admin");
      expect(await f.count("username_retired WHERE fold = 'race_by_player'")).toBe(1);
    });
  });

  describe("sign-in reset", () => {
    it("ends every token, code and push device of the player, sets the cutoff and audits ids only", async () => {
      const target = await player();
      const bystander = await player();
      const device = await f.phone(target.id);
      const second = await f.signIn(target.id);
      const kept = await f.signIn(bystander.id);
      await liveCode(target.email);
      await liveCode(bystander.email);
      await f.owner(
        `INSERT INTO player_contact_challenge (id, player_id, token_hash, channel, contact, code_hash, expires_at,
                                               contact_fp)
         VALUES ($1, $2, $3, 'email', 'new@example.test', $4, now() + interval '5 minutes', $5)`,
        [randomUUID(), target.id, randomBytes(32), randomBytes(32), randomBytes(32)],
      );
      await f.deletionToken(target.id);

      const done = await reset(target.id);
      expect(done?.ended).toBe(2);
      expect(await ownerOf(device.session)).toBeNull();
      expect(await ownerOf(second.session)).toBeNull();
      expect(await rotate(second.refresh)).toBe("invalid");
      expect(await f.count("push_device WHERE player_id = $1", [target.id])).toBe(0);
      expect(await f.count("player_login_challenge WHERE contact = $1", [target.email])).toBe(0);
      expect(await f.count("player_contact_challenge WHERE player_id = $1", [target.id])).toBe(0);
      expect(await f.count("player_deletion_challenge WHERE player_id = $1", [target.id])).toBe(0);
      expect(
        await f.count("player WHERE id = $1 AND tokens_valid_after IS NOT NULL", [target.id]),
      ).toBe(1);

      expect(await ownerOf(kept.session)).toBe(bystander.id);
      expect(await f.count("player_login_challenge WHERE contact = $1", [bystander.email])).toBe(1);

      const entry = (await audits("player.reset_sign_in")).at(-1);
      expect(entry).toMatchObject({ actor_id: adminId, target_id: target.id });
      expect(entry?.after).toEqual({
        actionId: done?.action_id,
        reasonCode: "lost_access",
        endedFamilies: 2,
      });

      const fresh = await f.signIn(target.id);
      expect(await ownerOf(fresh.session)).toBe(target.id);
      expect(await rotate(fresh.refresh)).toBe("rotated");

      // A token row the reset's UPDATE could not see (issued by a transaction that began before the cutoff) is
      // refused by the cutoff alone.
      const stale = randomBytes(32);
      await f.owner(
        `INSERT INTO player_session (player_id, token_hash, expires_at, created_at)
         SELECT id, $2, now() + interval '1 hour', tokens_valid_after - interval '1 second' FROM player WHERE id = $1`,
        [target.id, stale],
      );
      expect(await ownerOf(stale)).toBeNull();
    });

    it("refuses an erased account; a second reset at once waits and ends nothing more", async () => {
      const gone = await player();
      await f.erase(gone.id);
      expect(await sqlstate(reset(gone.id))).toBe("PA404");

      const target = await player();
      await f.signIn(target.id);
      const values = [target.id, RESET.reasonCode, RESET.note, randomUUID()];
      const result = await f.crossed(
        { context: admin, sql: resetSql, values },
        { context: admin, sql: resetSql, values: [...values.slice(0, 3), randomUUID()] },
      );
      expect(result.waited).toBe(true);
      expect(result.first).toMatchObject({ ended: 1 });
      expect(result.second).toMatchObject({ ended: 0 });
      expect(await f.count("player_admin_action WHERE player_id = $1", [target.id])).toBe(2);
    });

    it("refuses what a refresh that held its row before the reset issued", async () => {
      const target = await player();
      const sign = await f.signIn(target.id);
      const access = randomBytes(32);
      const refresh = randomBytes(32);
      const result = await f.crossed(
        {
          context: {},
          sql: "SELECT outcome FROM rotate_player_refresh($1, $2, $3)",
          values: [sign.refresh, access, refresh],
        },
        {
          context: admin,
          sql: resetSql,
          values: [target.id, RESET.reasonCode, RESET.note, randomUUID()],
        },
      );
      expect(result.waited).toBe(true);
      expect(result.first).toEqual({ outcome: "rotated" });
      expect(await ownerOf(access)).toBeNull();
      expect(await rotate(refresh)).toBe("invalid");
    });

    it("refuses a refresh that waited behind the reset", async () => {
      const target = await player();
      const sign = await f.signIn(target.id);
      const access = randomBytes(32);
      const result = await f.crossed(
        {
          context: admin,
          sql: resetSql,
          values: [target.id, RESET.reasonCode, RESET.note, randomUUID()],
        },
        {
          context: {},
          sql: "SELECT outcome FROM rotate_player_refresh($1, $2, $3)",
          values: [sign.refresh, access, randomBytes(32)],
        },
      );
      expect(result.waited).toBe(true);
      expect(result.second).toEqual({ outcome: "invalid" });
      expect(await ownerOf(access)).toBeNull();
    });

    it("refuses what a sign-in that held its code before the reset issued", async () => {
      const target = await player();
      const live = await liveCode(target.email);
      const access = randomBytes(32);
      const refresh = randomBytes(32);
      const result = await f.crossed(
        {
          context: {},
          sql: signInSql,
          values: [live.token, live.code, access, refresh, randomUUID(), randomBytes(32)],
        },
        {
          context: admin,
          sql: resetSql,
          values: [target.id, RESET.reasonCode, RESET.note, randomUUID()],
        },
      );
      expect(result.waited).toBe(true);
      expect(result.first).toEqual({ outcome: "signed_in", player_id: target.id });
      expect(await ownerOf(access)).toBeNull();
      expect(await rotate(refresh)).toBe("invalid");
    });

    it("refuses a sign-in that waited behind the reset: its code is gone", async () => {
      const target = await player();
      const live = await liveCode(target.email);
      const access = randomBytes(32);
      const result = await f.crossed(
        {
          context: admin,
          sql: resetSql,
          values: [target.id, RESET.reasonCode, RESET.note, randomUUID()],
        },
        {
          context: {},
          sql: signInSql,
          values: [live.token, live.code, access, randomBytes(32), randomUUID(), randomBytes(32)],
        },
      );
      expect(result.waited).toBe(true);
      expect(result.second).toEqual({ outcome: "expired", player_id: null });
      expect(await ownerOf(access)).toBeNull();
    });
  });

  describe("erasure and the append-only rows", () => {
    it("deletes the account's action rows and keeps the retired name", async () => {
      const target = await player("erase_after_me");
      await rename(target.id, "erase_after_two");
      await reveal(target.id);
      await f.erase(target.id);
      expect(await f.count("player_admin_action WHERE player_id = $1", [target.id])).toBe(0);
      expect(await f.count("username_retired WHERE fold = 'erase_after_me'")).toBe(1);
    });

    it("refuses any change or removal of an action row outside erasure, even to the owner", async () => {
      const target = await player();
      await reveal(target.id);
      const where = "WHERE player_id = $1";
      expect(
        await sqlstate(
          f.owner(`UPDATE player_admin_action SET note = 'changed note text' ${where}`, [
            target.id,
          ]),
        ),
      ).toBe("42501");
      expect(await sqlstate(f.owner(`DELETE FROM player_admin_action ${where}`, [target.id]))).toBe(
        "42501",
      );
      // Since T-705 the ban pointer on player also refuses it (0A000), before the trigger is reached.
      expect(await sqlstate(f.owner("TRUNCATE player_admin_action"))).toMatch(/^(42501|0A000)$/);
    });
  });
});
