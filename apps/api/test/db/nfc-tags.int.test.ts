import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Member = Readonly<{ player: string; enrollment: string }>;
type Tapped = Readonly<{
  completion_id: string;
  points: string;
  replayed: boolean;
  quest_id: string;
}>;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const detail =
      pg.detail === undefined || pg.detail === "" || /^[0-9]/.test(pg.code ?? "")
        ? ""
        : `:${pg.detail}`;
    return `${pg.code}${detail}`;
  }
};
const as = (player: string): RequestContext => ({ playerId: player });
const NFC = ["quest_qr", "nfc"];
const UID = Buffer.from("04a1b2c3d4e5f6", "hex");
const OTHER_UID = Buffer.from("04ffeeddccbbaa", "hex");
const noop = (): void => undefined;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * NFC tags in the database (T-308, migration 0056, ADR-234): the method's walls, writing a tag (the operator, the
 * ability, the quest, the limits, the sticker swap, a second confirm of one tag), the tap door table (every refusal of
 * the one door, the copy count and the flag from the second mismatch, the retry after Revoke and Move), the team's
 * Tags panel, Move and Revoke, the rehearsal wipe, the event delete, the crossed locks and another organizer.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("NFC tags (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const query = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client: PoolClient = await pool.connect();
    try {
      return await withRequestContext(
        client,
        context,
        async () => (await client.query<T>(sql, values)).rows,
      );
    } finally {
      client.release();
    }
  };
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: ownerB });

  const newEvent = async (status = "live", startsIn = "-2 hours", endsIn = "1 day") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Tower Fest', $3, now() + $4::interval, now() + $5::interval) RETURNING id`,
      [ids.orgA, `NFC${counter}`, status, startsIn, endsIn],
    );
    return event?.id ?? "";
  };
  const newCategory = async (event: string) => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'Stage') RETURNING id",
      [event],
    );
    return category?.id ?? "";
  };
  const newQuest = async (
    event: string,
    fields: Readonly<{
      category?: string;
      verification?: string[];
      repeat?: number;
      type?: string;
    }> = {},
  ) => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, verification)
       VALUES ($1, $2, $3, 'Tower', 10, $4, $5) RETURNING id`,
      [
        event,
        fields.category ?? (await newCategory(event)),
        fields.type ?? "scan_qr",
        fields.repeat ?? 100,
        fields.verification ?? NFC,
      ],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, via = "code", organizer = ids.orgA): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`nfc_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [organizer, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const operator = async (
    event: string,
    abilities = ["scan_quests", "write_nfc"],
    organizer = ids.orgA,
  ) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`nfc_operator_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [organizer, event, player?.id, abilities],
    );
    return { player: player?.id ?? "", assignment: made?.id ?? "" };
  };
  const register = (
    who: string,
    event: string,
    quest: string,
    fields: Readonly<{ tag?: string; uid?: Buffer; label?: string; locked?: boolean }> = {},
  ) =>
    query<{
      tag_id: string;
      quest_id: string;
      replaced_label: string | null;
      replaced_quest: string | null;
      replaced_title_en: string | null;
    }>(as(who), "SELECT * FROM register_nfc_tag($1, $2, $3, $4, $5, $6, $7)", [
      event,
      quest,
      fields.tag ?? randomUUID(),
      fields.uid ?? UID,
      fields.label ?? "Gate",
      fields.locked ?? true,
      randomUUID(),
    ]).then((rows) => rows[0]);
  /** A registered tag written straight in, as register would. */
  const tagOn = async (event: string, quest: string, uid: Buffer = UID) => {
    const [made] = await owner<{ id: string }>(
      `INSERT INTO nfc_tag (id, organizer_id, event_id, quest_id, uid, label, locked)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Gate', true) RETURNING id`,
      [ids.orgA, event, quest, uid],
    );
    return made?.id ?? "";
  };
  const tap = (
    player: string,
    tag: string,
    fields: Readonly<{
      uid?: Buffer | null;
      unreadable?: boolean;
      key?: string;
    }> = {},
  ) =>
    query<Tapped>(as(player), "SELECT * FROM tap_quest($1, $2, $3, $4, NULL)", [
      tag,
      fields.uid === undefined ? UID : fields.uid,
      fields.unreadable ?? false,
      fields.key ?? randomUUID(),
    ]).then((rows) => rows[0]);
  const tapRow = async (completion: string | undefined) =>
    (
      await owner<{ tag_id: string; uid_ok: boolean | null }>(
        "SELECT tag_id, uid_ok FROM nfc_tap WHERE completion_id = $1",
        [completion],
      )
    )[0];
  const copyFlag = async (who: Member) =>
    (
      await owner<{ evidence: { completions: number[] } }>(
        "SELECT evidence FROM flag WHERE enrollment_id = $1 AND kind = 'nfc_copy' AND status = 'open'",
        [who.enrollment],
      )
    )[0];
  const panel = async (event: string, quest: string, team = teamA()) =>
    (await query<{ tags: Row[] }>(team, "SELECT quest_nfc_tags($1, $2) AS tags", [event, quest]))[0]
      ?.tags ?? [];
  const hold = async (context: RequestContext, sql: string, values: unknown[]) => {
    const client = await pool.connect();
    let release = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = noop;
    const started = new Promise<void>((resolve) => {
      ran = resolve;
    });
    const done = withRequestContext(client, context, async () => {
      const rows = (await client.query(sql, values)).rows;
      ran();
      await gate;
      return rows;
    }).finally(() => client.release());
    await Promise.race([started, done]);
    return { release, done };
  };
  const waitsOnLock = async (fragment: string) => {
    for (let tries = 0; tries < 100; tries += 1) {
      const rows = await owner(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${fragment}%`],
      );
      if (rows.length > 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  // ============================================================ the method's walls
  describe("the method (FR-313)", () => {
    it("allows NFC on a scan quest only, and only with the quest QR", async () => {
      const event = await newEvent();
      expect(await refusal(newQuest(event, { verification: ["quest_qr", "nfc"] }))).toBe("none");
      expect(await refusal(newQuest(event, { verification: ["quest_qr", "my_qr", "nfc"] }))).toBe(
        "none",
      );
      expect(await refusal(newQuest(event, { verification: ["nfc"] }))).toBe("23514");
      expect(await refusal(newQuest(event, { verification: ["my_qr", "nfc"] }))).toBe("23514");
      expect(
        await refusal(newQuest(event, { type: "location", verification: ["quest_qr", "nfc"] })),
      ).toBe("23514");
      const quest = await newQuest(event);
      expect(
        await refusal(owner("UPDATE quest SET verification = '{nfc}' WHERE id = $1", [quest])),
      ).toBe("23514");
    });

    it("never takes nfc at the player's own door (complete_quest), so it cannot be claimed without a tag", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      expect(
        await refusal(
          query(as(who.player), "SELECT * FROM complete_quest($1, 'nfc', NULL, NULL, $2, NULL)", [
            quest,
            randomUUID(),
          ]),
        ),
      ).toBe("QV422:wrong_method");
    });

    it("keeps both tables closed to the API role", async () => {
      for (const sql of ["SELECT * FROM nfc_tag", "SELECT * FROM nfc_tap"]) {
        expect(await refusal(query(teamA(), sql))).toBe("42501");
      }
    });
  });

  // ============================================================ writing a tag
  describe("writing a tag (FR-312)", () => {
    it("prepares a fresh id and registers the tag, audited without the sticker id", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      const [prepared] = await query<{ id: string }>(
        as(op.player),
        "SELECT prepare_nfc_tag($1, $2) AS id",
        [event, quest],
      );
      expect(prepared?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await owner("SELECT 1 FROM nfc_tag WHERE id = $1", [prepared?.id])).toEqual([]);
      const made = await register(op.player, event, quest, {
        tag: prepared?.id ?? "",
        label: "  Gate 1 ",
      });
      expect(made).toMatchObject({ tag_id: prepared?.id, quest_id: quest, replaced_label: null });
      const [row] = await owner<Row>(
        "SELECT label, locked, status, written_by FROM nfc_tag WHERE id = $1",
        [prepared?.id],
      );
      expect(row).toEqual({
        label: "Gate 1",
        locked: true,
        status: "active",
        written_by: op.assignment,
      });
      const audit = await owner<{ after: Row }>(
        "SELECT after FROM audit_log WHERE action = 'nfc_tag.write' AND target_id = $1",
        [prepared?.id],
      );
      expect(audit[0]?.after).toEqual({
        operatorId: op.assignment,
        questId: quest,
        label: "Gate 1",
        locked: true,
      });
      expect(JSON.stringify(audit)).not.toContain(UID.toString("hex"));
    });

    it("refuses a non-operator, the ability off, a quest outside the event or the operator's list, no NFC, an ended event", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const plain = await newQuest(event, { verification: ["quest_qr"] });
      const other = await newQuest(await newEvent());
      const stranger = await member(event);
      const off = await operator(event, ["scan_quests"]);
      const op = await operator(event);
      const limited = await operator(event);
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [limited.assignment, event, plain],
      );
      expect(await refusal(register(stranger.player, event, quest))).toBe("OP403");
      expect(await refusal(register(off.player, event, quest))).toBe("OA403");
      expect(await refusal(register(op.player, event, other))).toBe("OQ404");
      expect(await refusal(register(limited.player, event, quest))).toBe("OS403");
      expect(await refusal(register(op.player, event, plain))).toBe("NT409:not_nfc");
      expect(
        await refusal(query(as(op.player), "SELECT prepare_nfc_tag($1, $2)", [event, plain])),
      ).toBe("NT409:not_nfc");
      const ended = await newEvent("live", "-2 days", "-1 hour");
      const late = await newQuest(ended);
      const lateOp = await operator(ended);
      expect(await refusal(register(lateOp.player, ended, late))).toBe("NT409:event_closed");
      expect(
        await refusal(query(as(lateOp.player), "SELECT prepare_nfc_tag($1, $2)", [ended, late])),
      ).toBe("NT409:event_closed");
    });

    it("bounds the sticker id and the label", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      expect(await refusal(register(op.player, event, quest, { uid: Buffer.alloc(3) }))).toBe(
        "NT422:uid",
      );
      expect(await refusal(register(op.player, event, quest, { uid: Buffer.alloc(11) }))).toBe(
        "NT422:uid",
      );
      expect(await refusal(register(op.player, event, quest, { label: "x".repeat(41) }))).toBe(
        "NT422:label",
      );
      expect(
        await refusal(register(op.player, event, quest, { uid: Buffer.alloc(4), label: "" })),
      ).toBe("none");
      expect(
        await refusal(
          register(op.player, event, quest, { uid: Buffer.alloc(10, 1), label: "x".repeat(40) }),
        ),
      ).toBe("none");
    });

    it("answers already_registered for a second confirm of one prepared tag (CTO C)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      const tag = randomUUID();
      await register(op.player, event, quest, { tag });
      expect(await refusal(register(op.player, event, quest, { tag }))).toBe(
        "NT409:already_registered",
      );
      expect(await refusal(register(op.player, event, quest, { tag, uid: OTHER_UID }))).toBe(
        "NT409:already_registered",
      );
    });

    it("rewriting a registered sticker revokes its old row and names it; another event may hold the same sticker", async () => {
      const event = await newEvent();
      const first = await newQuest(event);
      const second = await newQuest(event);
      const op = await operator(event);
      const old = await register(op.player, event, first, { label: "Old gate" });
      const made = await register(op.player, event, second, { label: "New gate" });
      expect(made).toMatchObject({
        replaced_label: "Old gate",
        replaced_quest: first,
        replaced_title_en: "Tower",
      });
      const [revoked] = await owner<{ status: string; revoked_at: Date | null }>(
        "SELECT status, revoked_at FROM nfc_tag WHERE id = $1",
        [old?.tag_id],
      );
      expect(revoked?.status).toBe("revoked");
      expect(revoked?.revoked_at).not.toBeNull();
      expect(
        await owner("SELECT 1 FROM audit_log WHERE action = 'nfc_tag.revoke' AND target_id = $1", [
          old?.tag_id,
        ]),
      ).toHaveLength(1);
      const elsewhere = await newEvent();
      const there = await newQuest(elsewhere);
      const otherOp = await operator(elsewhere);
      expect((await register(otherOp.player, elsewhere, there))?.replaced_label).toBeNull();
    });

    it("holds 50 active tags a quest; a revoked one frees its place, a sticker swap at the limit passes", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      await owner(
        `INSERT INTO nfc_tag (id, organizer_id, event_id, quest_id, uid, locked)
         SELECT gen_random_uuid(), $1, $2, $3, int4send(n) || '\\x00'::bytea, true FROM generate_series(1, 50) n`,
        [ids.orgA, event, quest],
      );
      expect(await refusal(register(op.player, event, quest))).toBe("NT409:limit_reached");
      const swap = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from([0])]);
      expect(await refusal(register(op.player, event, quest, { uid: swap }))).toBe("none");
      await owner(
        `UPDATE nfc_tag SET status = 'revoked', revoked_at = now()
         WHERE id = (SELECT id FROM nfc_tag WHERE quest_id = $1 AND status = 'active' LIMIT 1)`,
        [quest],
      );
      expect(await refusal(register(op.player, event, quest))).toBe("none");
    });

    it("lists the operator's quests with NFC and their own writes; refuses without the ability", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      await newQuest(event, { verification: ["quest_qr"] });
      const op = await operator(event);
      const peer = await operator(event);
      await register(op.player, event, quest, { label: "Mine" });
      await register(peer.player, event, quest, { label: "Theirs", uid: OTHER_UID });
      const [page] = await query<{ p: { quests: Row[]; tags: Row[] } }>(
        as(op.player),
        "SELECT operator_nfc_tags($1) AS p",
        [event],
      );
      expect(page?.p.quests).toEqual([{ id: quest, titleAr: null, titleEn: "Tower", tags: 2 }]);
      expect(page?.p.tags.map((row) => row["label"])).toEqual(["Mine"]);
      const off = await operator(event, ["scan_quests"]);
      expect(await refusal(query(as(off.player), "SELECT operator_nfc_tags($1)", [event]))).toBe(
        "OA403",
      );
      const stranger = await member(event);
      expect(
        await refusal(query(as(stranger.player), "SELECT operator_nfc_tags($1)", [event])),
      ).toBe("OP403");
    });
  });

  // ============================================================ the tap door table
  describe("the tap door table (FR-313, FR-621)", () => {
    it("an active tag pays as method nfc, with its tap row and the quest", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const who = await member(event);
      const paid = await tap(who.player, tag);
      expect(paid).toMatchObject({ points: "10", replayed: false, quest_id: quest });
      const [done] = await owner<{ method: string }>(
        "SELECT method FROM quest_completion WHERE id = $1",
        [paid?.completion_id],
      );
      expect(done?.method).toBe("nfc");
      expect(await tapRow(paid?.completion_id)).toEqual({ tag_id: tag, uid_ok: true });
    });

    it("answers unknown_tag for an unknown or revoked tag, and for another organizer's or event's", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const who = await member(event);
      expect(await refusal(tap(who.player, randomUUID()))).toBe("NT404");
      const elsewhere = await newEvent();
      const there = await tagOn(elsewhere, await newQuest(elsewhere));
      expect(await refusal(tap(who.player, there))).toBe("NT404");
      const outsider = await member(ids.eventB, "code", ids.orgB);
      expect(await refusal(tap(outsider.player, tag))).toBe("NT404");
      await owner("UPDATE nfc_tag SET status = 'revoked', revoked_at = now() WHERE id = $1", [tag]);
      expect(await refusal(tap(who.player, tag))).toBe("NT404");
    });

    it("runs every rule of the one door: method off, hidden, not started, ended, audience, cap", async () => {
      const event = await newEvent();
      const cases: readonly [string, string, string][] = [
        [
          "nfc off after writing",
          "UPDATE quest SET verification = '{quest_qr}' WHERE id = $1",
          "QV422:wrong_method",
        ],
        ["hidden", "UPDATE quest SET visible = false WHERE id = $1", "QN403:hidden"],
        [
          "not started",
          "UPDATE quest SET opens_at = now() + interval '1 hour' WHERE id = $1",
          "QN403:not_started",
        ],
        [
          "ended",
          "UPDATE quest SET opens_at = now() - interval '2 hours', closes_at = now() - interval '1 hour' WHERE id = $1",
          "QN403:ended",
        ],
        [
          "not in the audience",
          "UPDATE category SET hidden = true WHERE id = (SELECT category_id FROM quest WHERE id = $1)",
          "QN403:not_for_you",
        ],
      ];
      for (const [name, sql, expected] of cases) {
        const quest = await newQuest(event);
        const uid = randomBytes(7);
        const tag = await tagOn(event, quest, uid);
        const who = await member(event);
        await owner(sql, [quest]);
        expect(await refusal(tap(who.player, tag, { uid })), name).toBe(expected);
      }
      const capped = await newQuest(event, { repeat: 1 });
      const uid = randomBytes(7);
      const tag = await tagOn(event, capped, uid);
      const who = await member(event);
      await tap(who.player, tag, { uid });
      expect(await refusal(tap(who.player, tag, { uid }))).toBe("QD409:1");
    });

    it("keeps a category lock: a quest of a category unlocked after another is refused", async () => {
      const event = await newEvent();
      const first = await newCategory(event);
      const second = await newCategory(event);
      await newQuest(event, { category: first });
      await owner("UPDATE category SET unlock_after = $2 WHERE id = $1", [second, first]);
      const quest = await newQuest(event, { category: second });
      const tag = await tagOn(event, quest);
      const who = await member(event);
      expect(await refusal(tap(who.player, tag))).toMatch(/^QN403:/);
    });

    it("pays a boost in force ×2, as a scan", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const tag = await tagOn(event, quest);
      const [boost] = await owner<{ id: string }>(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         VALUES ($1, $2, $3, now() - interval '5 minutes', now() + interval '30 minutes') RETURNING id`,
        [ids.orgA, event, category],
      );
      const who = await member(event);
      expect((await tap(who.player, tag))?.points).toBe("20");
      const [entry] = await owner<{ boost_id: string }>(
        "SELECT boost_id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'",
        [who.enrollment],
      );
      expect(entry?.boost_id).toBe(boost?.id);
    });

    it("replays a retry with the same key: no second tap row, no second flag; the same key on another quest is QK422", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const other = await tagOn(event, await newQuest(event), OTHER_UID);
      const who = await member(event);
      const key = randomUUID();
      const first = await tap(who.player, tag, { key, uid: OTHER_UID });
      const again = await tap(who.player, tag, { key, uid: OTHER_UID });
      expect(again).toMatchObject({ completion_id: first?.completion_id, replayed: true });
      expect(await owner("SELECT 1 FROM nfc_tap WHERE tag_id = $1", [tag])).toHaveLength(1);
      expect(await copyFlag(who)).toBeUndefined();
      const qr = randomUUID();
      await query(as(who.player), "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [
        quest,
        qr,
      ]);
      expect(await refusal(tap(who.player, other, { key: qr }))).toBe("QK422");
      expect(await refusal(tap(who.player, tag, { key: qr }))).toBe("QK422");
    });

    it("pays a mismatched or missing sticker id, counts it on the tag, and flags the account only at the second (CTO 9)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const who = await member(event);
      const first = await tap(who.player, tag, { uid: OTHER_UID });
      expect(first?.points).toBe("10");
      expect((await tapRow(first?.completion_id))?.uid_ok).toBe(false);
      expect(await copyFlag(who)).toBeUndefined();
      const second = await tap(who.player, tag, { uid: null });
      expect((await tapRow(second?.completion_id))?.uid_ok).toBe(false);
      expect((await copyFlag(who))?.evidence.completions).toEqual([
        Number(first?.completion_id),
        Number(second?.completion_id),
      ]);
      const third = await tap(who.player, tag, { uid: OTHER_UID });
      expect((await copyFlag(who))?.evidence.completions).toHaveLength(3);
      expect(third?.replayed).toBe(false);
      const [row] = await panel(event, quest);
      expect(row).toMatchObject({ taps: 3, copies: 3, unchecked: 0 });
      const honest = await member(event);
      await tap(honest.player, tag);
      expect((await panel(event, quest))[0]).toMatchObject({ taps: 4, copies: 3 });
    });

    it("a closed case starts the count again: one more mismatch after a clear does not flag", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const who = await member(event);
      await tap(who.player, tag, { uid: OTHER_UID });
      await tap(who.player, tag, { uid: OTHER_UID });
      await owner(
        `UPDATE flag SET status = 'cleared', resolution = 'cleared', resolved_at = now()
         WHERE enrollment_id = $1 AND kind = 'nfc_copy'`,
        [who.enrollment],
      );
      await tap(who.player, tag, { uid: OTHER_UID });
      expect(await copyFlag(who)).toBeUndefined();
      await tap(who.player, tag, { uid: OTHER_UID });
      expect((await copyFlag(who))?.evidence.completions).toHaveLength(2);
    });

    it("an unreadable sticker id (the iPhone's platform reason) is not checked, never flagged, and counted apart (CTO A)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const who = await member(event);
      for (let n = 0; n < 3; n += 1) {
        const paid = await tap(who.player, tag, { uid: null, unreadable: true });
        expect((await tapRow(paid?.completion_id))?.uid_ok).toBeNull();
      }
      expect(await copyFlag(who)).toBeUndefined();
      expect((await panel(event, quest))[0]).toMatchObject({ taps: 3, copies: 0, unchecked: 3 });
    });

    it("a retry after Revoke or Move answers the paid tap (CTO 1)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const target = await newQuest(event);
      for (const change of ["revoke", "move"] as const) {
        const tag = await tagOn(event, quest, change === "revoke" ? UID : OTHER_UID);
        const who = await member(event);
        const key = randomUUID();
        const uid = change === "revoke" ? UID : OTHER_UID;
        const first = await tap(who.player, tag, { key, uid });
        if (change === "revoke") {
          await query(teamA(), "SELECT revoke_nfc_tag($1, $2, $3)", [event, tag, randomUUID()]);
        } else {
          await query(teamA(), "SELECT move_nfc_tag($1, $2, $3, $4)", [
            event,
            tag,
            target,
            randomUUID(),
          ]);
        }
        const again = await tap(who.player, tag, { key, uid });
        expect(again, change).toMatchObject({
          completion_id: first?.completion_id,
          replayed: true,
          quest_id: quest,
        });
        if (change === "move") {
          const fresh = await tap(who.player, tag, { uid });
          expect(fresh).toMatchObject({ replayed: false, quest_id: target });
        } else {
          expect(await refusal(tap(who.player, tag, { uid }))).toBe("NT404");
        }
      }
    });
  });

  // ============================================================ the team
  describe("the Tags panel, Move and Revoke (owners and editors)", () => {
    it("lists a quest's tags with who wrote them; another organizer's team gets AN404", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      const made = await register(op.player, event, quest, { label: "Gate" });
      const [row] = await panel(event, quest);
      expect(row).toMatchObject({
        id: made?.tag_id,
        label: "Gate",
        locked: true,
        status: "active",
        taps: 0,
        copies: 0,
        unchecked: 0,
        lastTapAt: null,
      });
      expect(String(row?.["writtenBy"])).toMatch(/^nfc_operator_/);
      expect(await refusal(panel(event, quest, teamB()))).toBe("AN404");
    });

    it("moves a tag to another NFC quest of the event, audited; refuses a quest without NFC or of another event", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const target = await newQuest(event);
      const plain = await newQuest(event, { verification: ["quest_qr"] });
      const elsewhere = await newQuest(await newEvent());
      const tag = await tagOn(event, quest);
      const move = (to: string, team = teamA()) =>
        query(team, "SELECT move_nfc_tag($1, $2, $3, $4)", [event, tag, to, randomUUID()]);
      expect(await refusal(move(plain))).toBe("NT409:not_nfc");
      expect(await refusal(move(elsewhere))).toBe("NT409:not_nfc");
      expect(await refusal(move(target, teamB()))).toBe("AN404");
      await move(target);
      const [row] = await owner<{ quest_id: string }>(
        "SELECT quest_id FROM nfc_tag WHERE id = $1",
        [tag],
      );
      expect(row?.quest_id).toBe(target);
      expect(
        await owner("SELECT 1 FROM audit_log WHERE action = 'nfc_tag.move' AND target_id = $1", [
          tag,
        ]),
      ).toHaveLength(1);
      await move(target);
      expect(
        await owner("SELECT 1 FROM audit_log WHERE action = 'nfc_tag.move' AND target_id = $1", [
          tag,
        ]),
      ).toHaveLength(1);
    });

    it("revokes one tag or all of a quest's, audited; a revoked tag can not be revoked or moved again", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const one = await tagOn(event, quest);
      const two = await tagOn(event, quest, OTHER_UID);
      await query(teamA(), "SELECT revoke_nfc_tag($1, $2, $3)", [event, one, randomUUID()]);
      expect(
        await refusal(
          query(teamA(), "SELECT revoke_nfc_tag($1, $2, $3)", [event, one, randomUUID()]),
        ),
      ).toBe("NT404");
      expect(
        await refusal(
          query(teamB(), "SELECT revoke_nfc_tag($1, $2, $3)", [event, two, randomUUID()]),
        ),
      ).toBe("AN404");
      const [all] = await query<{ n: number }>(
        teamA(),
        "SELECT revoke_quest_nfc_tags($1, $2, $3) AS n",
        [event, quest, randomUUID()],
      );
      expect(all?.n).toBe(1);
      expect(
        await owner("SELECT status FROM nfc_tag WHERE quest_id = $1 ORDER BY status", [quest]),
      ).toEqual([{ status: "revoked" }, { status: "revoked" }]);
      expect(
        await refusal(
          query(teamA(), "SELECT revoke_quest_nfc_tags($1, $2, $3)", [
            event,
            await newQuest(await newEvent()),
            randomUUID(),
          ]),
        ),
      ).toBe("AN404");
    });

    it("deletes a quest once its tags are revoked: tapless ones go, tapped ones are detached and kept (CTO code review 1)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tapless = await tagOn(event, quest);
      const tapped = await tagOn(event, quest, OTHER_UID);
      const target = await newQuest(event);
      const who = await member(event);
      await tap(who.player, tapped, { uid: OTHER_UID });
      await query(teamA(), "SELECT move_nfc_tag($1, $2, $3, $4)", [
        event,
        tapped,
        target,
        randomUUID(),
      ]);
      await query(teamA(), "SELECT move_nfc_tag($1, $2, $3, $4)", [
        event,
        tapless,
        target,
        randomUUID(),
      ]);
      // The tapped tag's completion is on the first quest; the second has none, only the two moved tags.
      expect(await refusal(owner("DELETE FROM quest WHERE id = $1", [target]))).toBe("23503");
      await query(teamA(), "SELECT revoke_quest_nfc_tags($1, $2, $3)", [
        event,
        target,
        randomUUID(),
      ]);
      expect(await refusal(owner("DELETE FROM quest WHERE id = $1", [target]))).toBe("none");
      expect(await owner("SELECT 1 FROM nfc_tag WHERE id = $1", [tapless])).toEqual([]);
      expect(await owner("SELECT quest_id, status FROM nfc_tag WHERE id = $1", [tapped])).toEqual([
        { quest_id: null, status: "revoked" },
      ]);
      expect(await owner("SELECT 1 FROM nfc_tap WHERE tag_id = $1", [tapped])).toHaveLength(1);
      expect(
        await refusal(
          owner("UPDATE nfc_tag SET status = 'active', revoked_at = NULL WHERE id = $1", [tapped]),
        ),
      ).toBe("23514");
    });

    it("keeps a quest with tags from being deleted; the event's delete removes its tags first (CTO 4)", async () => {
      const event = await newEvent("draft", "1 day", "2 days");
      const quest = await newQuest(event);
      await tagOn(event, quest);
      expect(await refusal(owner("DELETE FROM quest WHERE id = $1", [quest]))).toBe("23503");
      expect(await refusal(owner("DELETE FROM event WHERE id = $1", [event]))).toBe("none");
      expect(await owner("SELECT 1 FROM nfc_tag WHERE event_id = $1", [event])).toEqual([]);
    });
  });

  // ============================================================ rehearsal
  describe("rehearsal and the go-live wipe", () => {
    it("a rehearsal tap's row goes with its completion; the tag stays and pays live", async () => {
      const event = await newEvent("scheduled", "30 minutes", "1 day");
      counter += 1;
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, $3)",
        [
          event,
          ids.orgA,
          `${LETTERS[counter % 24]}${LETTERS[Math.floor(counter / 24) % 24]}NF-TAGX`,
        ],
      );
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const rehearsal = await member(event, "rehearsal");
      const practice = await tap(rehearsal.player, tag);
      expect(await tapRow(practice?.completion_id)).toBeDefined();
      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      const player = await member(event);
      const live = await tap(player.player, tag);
      expect(live?.replayed).toBe(false);
      expect(await tapRow(practice?.completion_id)).toBeUndefined();
      expect(await owner("SELECT 1 FROM nfc_tag WHERE id = $1", [tag])).toHaveLength(1);
      expect(await owner("SELECT 1 FROM nfc_tap WHERE tag_id = $1", [tag])).toHaveLength(1);
    });
  });

  describe("the go-live wipe runs before a retry is looked up (CTO code review 2)", () => {
    it("a rehearsal tap retried after go-live finds no account (unknown_tag, never a fresh payment)", async () => {
      const event = await newEvent("scheduled", "30 minutes", "1 day");
      counter += 1;
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, $3)",
        [
          event,
          ids.orgA,
          `${LETTERS[counter % 24]}${LETTERS[Math.floor(counter / 24) % 24]}NF-RTRY`,
        ],
      );
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const rehearsal = await member(event, "rehearsal");
      const key = randomUUID();
      await tap(rehearsal.player, tag, { key });
      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      await owner("UPDATE nfc_tag SET status = 'revoked', revoked_at = now() WHERE id = $1", [tag]);
      expect(await refusal(tap(rehearsal.player, tag, { key }))).toBe("NT404");
    });
  });

  // ============================================================ crossed locks
  describe("crossed locks", () => {
    it("a Revoke while a tap holds the tag's key does not wait; the tap pays", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const who = await member(event);
      const held = await hold(as(who.player), "SELECT * FROM tap_quest($1, $2, false, $3, NULL)", [
        tag,
        UID,
        randomUUID(),
      ]);
      await query(teamA(), "SELECT revoke_nfc_tag($1, $2, $3)", [event, tag, randomUUID()]);
      held.release();
      const rows = (await held.done) as Tapped[];
      expect(rows[0]?.replayed).toBe(false);
      expect(await tapRow(rows[0]?.completion_id)).toEqual({ tag_id: tag, uid_ok: true });
    });

    it("a tap after a committed Revoke is unknown_tag", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const who = await member(event);
      const held = await hold(teamA(), "SELECT revoke_nfc_tag($1, $2, $3)", [
        event,
        tag,
        randomUUID(),
      ]);
      held.release();
      await held.done;
      expect(await refusal(tap(who.player, tag))).toBe("NT404");
    });

    it("two confirms of one sticker serialise on the quest row: the second revokes the first", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event);
      const first = randomUUID();
      const held = await hold(
        as(op.player),
        "SELECT * FROM register_nfc_tag($1, $2, $3, $4, 'One', true, $5)",
        [event, quest, first, UID, randomUUID()],
      );
      const second = register(op.player, event, quest, { label: "Two" });
      expect(await waitsOnLock("register_nfc_tag")).toBe(true);
      held.release();
      await held.done;
      expect((await second)?.replaced_label).toBe("One");
      expect(
        await owner("SELECT label FROM nfc_tag WHERE event_id = $1 AND status = 'active'", [event]),
      ).toEqual([{ label: "Two" }]);
    });

    it("two players tapping one tag at once both pay", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const tag = await tagOn(event, quest);
      const one = await member(event);
      const two = await member(event);
      const held = await hold(as(one.player), "SELECT * FROM tap_quest($1, $2, false, $3, NULL)", [
        tag,
        UID,
        randomUUID(),
      ]);
      const other = await tap(two.player, tag);
      held.release();
      await held.done;
      expect(other?.replayed).toBe(false);
      expect(await owner("SELECT 1 FROM nfc_tap WHERE tag_id = $1", [tag])).toHaveLength(2);
    });
  });
});
