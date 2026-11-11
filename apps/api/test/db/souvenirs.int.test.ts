import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLocker } from "#src/players/items";
import { paySouvenirs } from "#src/souvenirs/payer";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";
import { souvenirFixture } from "#test/support/souvenirs";

describe.skipIf(TEST_DATABASE_URL === undefined)("event souvenirs", () => {
  let f: Awaited<ReturnType<typeof souvenirFixture>>;
  beforeEach(async () => {
    f = await souvenirFixture();
  });
  afterEach(async () => {
    await f.close();
  });

  it("grants joined players once with exact private source, own equip and seen acknowledgment", async () => {
    const rule = await f.create();
    await f.action(rule);
    expect((await f.grant()).rows[0].n).toBe(1);
    expect((await f.grant()).rows[0].n).toBe(0);
    const rows = await f.owned();
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      source: "souvenir",
      source_level: null,
      source_rule_id: rule,
      source_event_id: f.ids.eventA,
    });
    const client = await f.pool.connect();
    const locker = await withRequestContext(client, { playerId: f.ids.playerA }, () =>
      readLocker(client, undefined, 30),
    );
    client.release();
    expect(locker.items[0]?.source).toEqual({
      kind: "event",
      event: { id: f.ids.eventA, name: { ar: "Tech Fest", en: "Tech Fest" } },
      presentedBy: null,
    });
    await f.run({ playerId: f.ids.playerA }, "SELECT equip_player($1)", [
      { frameId: rows.rows[0].item_id },
    ]);
    await f.run({ playerId: f.ids.playerA }, "SELECT see_owned_items($1)", [
      [rows.rows[0].item_id],
    ]);
    expect((await f.owned()).rows[0].seen_at).not.toBeNull();
  });
  it("starts with a draft and creates no ownership before activation", async () => {
    await f.create();
    expect((await f.grant()).rows[0].n).toBe(0);
    expect((await f.owned()).rows).toEqual([]);
  });
  it.each(["category", "all"])(
    "requires all frozen %s targets and backfills prior done facts",
    async (audience) => {
      await f.complete();
      const rule = await f.create({
        audience,
        categoryId: audience === "category" ? f.category : null,
      });
      await f.action(rule);
      expect((await f.grant()).rows[0].n).toBe(1);
      await f.db.owner.query("UPDATE quest SET visible=false WHERE id=$1", [f.quest]);
      expect(
        (await f.db.owner.query("SELECT * FROM souvenir_target WHERE rule_id=$1", [rule])).rows,
      ).toHaveLength(1);
    },
  );
  it("does not grant an unfinished target and automatic work delivers after completion", async () => {
    const rule = await f.create({ audience: "category", categoryId: f.category });
    await f.action(rule);
    expect((await f.grant()).rows[0].n).toBe(0);
    await f.complete();
    await paySouvenirs({ pool: f.pool }, { eventId: f.ids.eventA, budgetMs: 5000 });
    expect((await f.owned()).rows).toHaveLength(1);
  });
  it("rejects empty target sets, including flash and live-poll-only groups", async () => {
    await f.db.owner.query("UPDATE quest SET visible=false WHERE id=$1", [f.quest]);
    const rule = await f.create({ audience: "all" });
    await expect(f.action(rule)).rejects.toMatchObject({ code: "SV409", detail: "souvenir_empty" });
    expect(
      (await f.db.owner.query("SELECT status FROM souvenir_rule WHERE id=$1", [rule])).rows[0]
        .status,
    ).toBe("draft");
  });
  it("freezes active item content, target identities and promises; stop retains ownership", async () => {
    const rule = await f.create();
    await f.action(rule);
    await f.grant();
    const item = (await f.owned()).rows[0].item_id;
    await expect(
      f.db.owner.query("UPDATE item SET name_en='Changed' WHERE id=$1", [item]),
    ).rejects.toMatchObject({ code: "SV409" });
    await expect(
      f.db.owner.query("UPDATE souvenir_rule SET audience='all' WHERE id=$1", [rule]),
    ).rejects.toMatchObject({ code: "SV409" });
    await f.action(rule, "stop");
    expect((await f.grant()).rows[0].n).toBe(0);
    expect((await f.owned()).rows).toHaveLength(1);
  });
  it("stops future grants and never reactivates a stopped promise", async () => {
    const rule = await f.create();
    await f.action(rule);
    await f.action(rule, "stop");
    expect((await f.grant()).rows[0].n).toBe(0);
    await expect(f.action(rule)).rejects.toMatchObject({ code: "SV409" });
  });
  it("persists same-key create/action replay and rejects changed-body replay without another audit", async () => {
    const key = randomUUID();
    const rule = await f.create({}, key);
    expect(await f.create({}, key)).toBe(rule);
    await expect(f.create({ audience: "all" }, key)).rejects.toMatchObject({
      code: "SV409",
      detail: "idempotency_conflict",
    });
    const activation = randomUUID();
    await f.action(rule, "activate", activation);
    await f.action(rule, "activate", activation);
    expect(
      (
        await f.db.owner.query(
          "SELECT action FROM audit_log WHERE action LIKE 'souvenir.%' ORDER BY id",
        )
      ).rows.map((r) => r.action),
    ).toEqual(["souvenir.create", "souvenir.activate"]);
  });
  it.each(["pending", "left", "banned", "removed"])(
    "refuses %s membership at grant time",
    async (status) => {
      const rule = await f.create();
      await f.action(rule);
      await f.db.owner.query("UPDATE enrollment SET status=$2 WHERE id=$1", [f.member, status]);
      expect((await f.grant()).rows[0].n).toBe(0);
      expect((await f.owned()).rows).toEqual([]);
    },
  );
  it("refuses waiting-list members and platform-banned players", async () => {
    const rule = await f.create();
    await f.action(rule);
    await f.db.owner.query("UPDATE enrollment SET status='pending',waitlisted=true WHERE id=$1", [
      f.member,
    ]);
    expect((await f.grant()).rows[0].n).toBe(0);
    await f.db.owner.query("UPDATE enrollment SET status='active',waitlisted=false WHERE id=$1", [
      f.member,
    ]);
    await f.db.owner.query("UPDATE player SET status='banned' WHERE id=$1", [f.ids.playerA]);
    expect((await f.grant()).rows[0].n).toBe(0);
  });
  it("denies non-attendees, foreign tenant rules, category forgery and limited editors", async () => {
    const rule = await f.create();
    await f.action(rule);
    const memberB = (
      await f.db.owner.query("SELECT id FROM enrollment WHERE player_id=$1", [f.ids.playerB])
    ).rows[0].id;
    expect((await f.run({}, "SELECT souvenir_evaluate($1) AS n", [memberB])).rows[0].n).toBe(0);
    await expect(f.run(f.actor, "SELECT souvenir_list($1)", [f.ids.eventB])).rejects.toMatchObject({
      code: "AN404",
    });
    const limited = await addMember(f.db.owner, f.ids.orgA, "editor", [f.ids.eventA]);
    await expect(
      f.run(
        { organizerId: f.ids.orgA, staffUserId: limited },
        "SELECT souvenir_action($1,$2,'stop',$3)",
        [f.ids.eventB, rule, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "AN404" });
  });
  it.each([
    {},
    { playerId: "playerA" },
    { staffUserId: "staff" },
    { isAdmin: true },
    { deviceId: "eventA" },
  ])("permits only empty system context for evaluation (%j)", async (seat) => {
    const context = Object.fromEntries(
      Object.entries(seat).map(([k, v]) => [
        k,
        typeof v === "string" ? (v === "staff" ? f.staff : f.ids[v as keyof typeof f.ids]) : v,
      ]),
    );
    if (Object.keys(context).length === 0) {
      expect(
        (await f.run(context, "SELECT souvenir_evaluate($1) AS n", [f.member])).rows[0].n,
      ).toBe(0);
    } else
      await expect(
        f.run(context, "SELECT souvenir_evaluate($1)", [f.member]),
      ).rejects.toMatchObject({ code: "SV403" });
  });
  it("keeps event source outside public profile/equipment and retains souvenirs after archive", async () => {
    const rule = await f.create();
    await f.action(rule);
    await f.grant();
    const item = (await f.owned()).rows[0].item_id;
    await f.run({ playerId: f.ids.playerA }, "SELECT equip_player($1)", [{ frameId: item }]);
    const read = await f.run(
      { playerId: f.ids.playerB },
      "SELECT public_player_profile('sara_k') AS profile",
    );
    expect(JSON.stringify(read.rows[0].profile)).not.toContain(f.ids.eventA);
    expect(JSON.stringify(read.rows[0].profile)).not.toContain("Tech Fest");
    await f.db.owner.query("UPDATE event SET status='archived' WHERE id=$1", [f.ids.eventA]);
    expect((await f.owned()).rows).toHaveLength(1);
    await expect(f.action(rule, "stop")).rejects.toMatchObject({
      code: "SV409",
      detail: "event_archived",
    });
  });
  it("erases equipment, ownership, receipts and queued work without regranting tombstones", async () => {
    const rule = await f.create();
    await f.action(rule);
    await f.grant();
    const token = await f.deletion();
    await f.run({}, "SELECT * FROM erase_player($1,true,$2)", [token, randomUUID()]);
    expect((await f.grant()).rows[0].n).toBe(0);
    expect((await f.owned()).rows).toEqual([]);
    expect(
      (await f.db.owner.query("SELECT * FROM souvenir_receipt WHERE player_id=$1", [f.ids.playerA]))
        .rows,
    ).toEqual([]);
    expect(
      (await f.db.owner.query("SELECT * FROM souvenir_work WHERE enrollment_id=$1", [f.member]))
        .rows,
    ).toEqual([]);
  });

  it("denies direct souvenir table reads/writes and immutable grant changes", async () => {
    for (const table of [
      "souvenir_rule",
      "souvenir_target",
      "souvenir_receipt",
      "souvenir_work",
      "souvenir_scan",
      "souvenir_command",
    ]) {
      await expect(f.run(f.actor, `SELECT * FROM ${table}`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(f.run({ isAdmin: true }, `DELETE FROM ${table}`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(f.run(f.actor, `INSERT INTO ${table} DEFAULT VALUES`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(f.db.outsider.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({
        code: "42501",
      });
    }
    const rule = await f.create();
    await f.action(rule);
    await f.grant();
    await expect(
      f.db.owner.query(
        "UPDATE player_item SET source_rule_id=NULL WHERE player_id=$1 AND source='souvenir'",
        [f.ids.playerA],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(f.db.owner.query("DELETE FROM souvenir_receipt")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(f.db.owner.query("TRUNCATE souvenir_receipt CASCADE")).rejects.toMatchObject({
      code: "42501",
    });
  });
  it("rejects stale membership, disabled staff, admin and device organizer contexts", async () => {
    const rule = await f.create();
    await expect(
      f.run({ ...f.actor, isAdmin: true }, "SELECT souvenir_list($1)", [f.ids.eventA]),
    ).rejects.toMatchObject({ code: "AN404" });
    await expect(
      f.run({ ...f.actor, deviceId: randomUUID() }, "SELECT souvenir_list($1)", [f.ids.eventA]),
    ).rejects.toMatchObject({ code: "AN404" });
    await f.db.owner.query("UPDATE staff_user SET status='disabled' WHERE id=$1", [f.staff]);
    await expect(f.action(rule)).rejects.toMatchObject({ code: "AN404" });
    await f.db.owner.query("UPDATE staff_user SET status='active' WHERE id=$1", [f.staff]);
    await f.db.owner.query("DELETE FROM organizer_member WHERE staff_user_id=$1", [f.staff]);
    await expect(f.action(rule)).rejects.toMatchObject({ code: "AN404" });
  });
  /** A suspension of event A (migration 0190): the event itself, or its organizer paused. */
  const HOLDS = [
    {
      name: "event A is suspended",
      hold: () =>
        f.db.owner.query(
          "UPDATE event SET suspended_at=now(),suspension_reason='Checking a report' WHERE id=$1",
          [f.ids.eventA],
        ),
      lift: () =>
        f.db.owner.query("UPDATE event SET suspended_at=NULL,suspension_reason=NULL WHERE id=$1", [
          f.ids.eventA,
        ]),
    },
    {
      name: "event A's organizer is paused",
      hold: () =>
        f.db.owner.query(
          "UPDATE organizer SET status='paused',suspended_at=now(),suspension_reason='Checking a report' WHERE id=$1",
          [f.ids.orgA],
        ),
      lift: () =>
        f.db.owner.query(
          "UPDATE organizer SET status='active',suspended_at=NULL,suspension_reason=NULL WHERE id=$1",
          [f.ids.orgA],
        ),
    },
  ] as const;
  const scan = async () =>
    (await f.run({}, "SELECT souvenir_scan_batch($1) AS n", [f.ids.eventA])).rows[0].n as number;
  const claim = async () =>
    (await f.run({}, "SELECT * FROM souvenir_claim_work(NULL,20)")).rows as {
      enrollment_id: string;
    }[];
  const work = async () =>
    (await f.db.owner.query("SELECT * FROM souvenir_work WHERE enrollment_id=$1", [f.member])).rows;
  const scans = async (rule: string) =>
    (await f.db.owner.query("SELECT * FROM souvenir_scan WHERE rule_id=$1", [rule])).rows;
  const health = async () =>
    (await f.run({}, "SELECT souvenir_health() AS h")).rows[0].h as {
      due: number;
      failed: number;
      held: number;
      oldestAt: string | null;
    };

  describe.each(HOLDS)("while $name (migration 0190)", ({ hold, lift }) => {
    it("keeps the scan row waiting and enqueues nobody, then scans after the lift", async () => {
      const rule = await f.create();
      await f.action(rule);
      await hold();
      expect(await scan()).toBe(0);
      expect((await f.run({}, "SELECT souvenir_scan_batch(NULL) AS n")).rows[0].n).toBe(0);
      expect(await scans(rule)).toHaveLength(1);
      await lift();
      expect(await scan()).toBe(1);
      expect(await work()).toHaveLength(1);
    });

    it("leaves its queued work unclaimed, then claims it after the lift", async () => {
      const rule = await f.create();
      await f.action(rule);
      expect(await scan()).toBe(1);
      await hold();
      expect(await claim()).toEqual([]);
      expect(await work()).toHaveLength(1);
      await lift();
      expect((await claim()).map((row) => row.enrollment_id)).toEqual([f.member]);
    });

    it("refuses a grant with ES423 and keeps the work, delivered after the lift", async () => {
      const rule = await f.create();
      await f.action(rule);
      expect(await scan()).toBe(1);
      const [taken] = (await f.run({}, "SELECT * FROM souvenir_claim_work($1,20)", [f.ids.eventA]))
        .rows as { generation: string; lease_token: string }[];
      await hold();
      await expect(f.grant()).rejects.toMatchObject({ code: "ES423" });
      expect((await f.owned()).rows).toEqual([]);
      await f.run({}, "SELECT souvenir_ack($1,$2,$3,'ES423')", [
        f.member,
        taken?.generation,
        taken?.lease_token,
      ]);
      expect(await work()).toHaveLength(1);
      await lift();
      // The back-off of the failed attempt (5 s here, up to 300 s) has passed.
      await f.db.owner.query("UPDATE souvenir_work SET ready_at=now() WHERE enrollment_id=$1", [
        f.member,
      ]);
      await paySouvenirs({ pool: f.pool }, { eventId: f.ids.eventA, budgetMs: 5000 });
      expect((await f.owned()).rows).toHaveLength(1);
    });

    it("grants nothing on a paying run and delivers once lifted", async () => {
      const rule = await f.create();
      await f.action(rule);
      await hold();
      expect(
        await paySouvenirs({ pool: f.pool }, { eventId: f.ids.eventA, budgetMs: 5000 }),
      ).toEqual({ granted: 0, skipped: 0, failed: 0 });
      expect((await f.owned()).rows).toEqual([]);
      await lift();
      await paySouvenirs({ pool: f.pool }, { eventId: f.ids.eventA, budgetMs: 5000 });
      expect((await f.owned()).rows).toHaveLength(1);
    });

    it("reports its work as held, not due, failed or old, in the health read", async () => {
      const rule = await f.create();
      await f.action(rule);
      expect(await scan()).toBe(1);
      await f.db.owner.query(
        "UPDATE souvenir_work SET error_code='ES423',ready_at=now()-interval '10 minutes' WHERE enrollment_id=$1",
        [f.member],
      );
      await hold();
      expect(await health()).toEqual({ due: 0, failed: 0, held: 1, oldestAt: null });
      await lift();
      expect(await health()).toMatchObject({ due: 1, failed: 1, held: 0 });
      expect((await health()).oldestAt).not.toBeNull();
    });
  });

  it("never queues or grants a rehearsal membership even through backfill", async () => {
    const player = (
      await f.db.owner.query(
        "INSERT INTO player(username) VALUES('souvenir_practice') RETURNING id",
      )
    ).rows[0].id;
    const member = (
      await f.db.owner.query(
        "INSERT INTO enrollment(organizer_id,event_id,player_id,joined_via) VALUES($1,$2,$3,'rehearsal') RETURNING id",
        [f.ids.orgA, f.ids.eventA, player],
      )
    ).rows[0].id;
    const rule = await f.create();
    await f.action(rule);
    await f.run({}, "SELECT souvenir_scan_batch($1)", [f.ids.eventA]);
    expect(
      (await f.db.owner.query("SELECT * FROM souvenir_work WHERE enrollment_id=$1", [member])).rows,
    ).toEqual([]);
    expect((await f.run({}, "SELECT souvenir_evaluate($1) AS n", [member])).rows[0].n).toBe(0);
    expect((await f.grant()).rows[0].n).toBe(1);
    expect(
      (await f.db.owner.query("SELECT * FROM souvenir_receipt WHERE player_id=$1", [player])).rows,
    ).toEqual([]);
  });
});
