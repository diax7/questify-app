import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { souvenirFixture } from "#test/support/souvenirs";

describe.skipIf(TEST_DATABASE_URL === undefined)("souvenir final ranks", () => {
  let f: Awaited<ReturnType<typeof souvenirFixture>>;
  beforeEach(async () => {
    f = await souvenirFixture();
  });
  afterEach(async () => {
    await f.close();
  });
  const finish = async () => {
    await f.db.owner.query(
      "UPDATE event SET status='ended',ends_at=now()-interval '1 minute' WHERE id=$1",
      [f.ids.eventA],
    );
    const places = (
      await f.db.owner.query(
        "SELECT enrollment_id FROM current_places((SELECT e FROM event e WHERE id=$1)) ORDER BY rank",
        [f.ids.eventA],
      )
    ).rows.map((r) => r.enrollment_id);
    return f.run(f.actor, "SELECT confirm_results($1,$2,$3) AS outcome", [
      f.ids.eventA,
      places,
      randomUUID(),
    ]);
  };
  it("extends confirmed snapshot to rank20 even with physical prizes off, then grants the frozen recipient", async () => {
    await f.db.owner.query("UPDATE event SET rank_prizes=false WHERE id=$1", [f.ids.eventA]);
    await f.db.owner.query("UPDATE enrollment SET score=1,score_version=100 WHERE id=$1", [
      f.member,
    ]);
    for (let i = 1; i < 20; i += 1) {
      const player = (
        await f.db.owner.query("INSERT INTO player(username) VALUES($1) RETURNING id", [
          `rank_${i}`,
        ])
      ).rows[0].id;
      await f.db.owner.query(
        "INSERT INTO enrollment(organizer_id,event_id,player_id,score,score_version) VALUES($1,$2,$3,$4,$5)",
        [f.ids.orgA, f.ids.eventA, player, 30 - i, i],
      );
    }
    const rule = await f.create({ audience: "rank", rankFrom: 20, rankTo: 20 });
    await f.action(rule);
    expect((await f.grant()).rows[0].n).toBe(0);
    expect((await finish()).rows[0].outcome).toBe("confirmed");
    expect(
      (
        await f.db.owner.query("SELECT count(*)::int AS n FROM result_place WHERE event_id=$1", [
          f.ids.eventA,
        ])
      ).rows[0].n,
    ).toBe(20);
    expect((await f.grant()).rows[0].n).toBe(1);
    expect(
      (await f.db.owner.query("SELECT rank FROM result_place WHERE enrollment_id=$1", [f.member]))
        .rows[0].rank,
    ).toBe(20);
  });
  it("does not extend depth for drafts; refuses a new rank activation after confirmation", async () => {
    await f.db.owner.query("UPDATE enrollment SET score=1,score_version=100 WHERE id=$1", [
      f.member,
    ]);
    const rule = await f.create({ audience: "rank", rankFrom: 1, rankTo: 100 });
    expect(
      (
        await f.db.owner.query("SELECT result_depth(e) AS depth FROM event e WHERE id=$1", [
          f.ids.eventA,
        ])
      ).rows[0].depth,
    ).toBe(10);
    await finish();
    await expect(f.action(rule)).rejects.toMatchObject({ code: "SV409", detail: "results_final" });
  });
  it.each([
    [0, 1],
    [1, 101],
    [3, 1],
    [null, null],
  ])("refuses invalid rank range%s–%s in SQL", async (rankFrom, rankTo) => {
    await expect(f.create({ audience: "rank", rankFrom, rankTo })).rejects.toMatchObject({
      code: "23514",
    });
    expect((await f.db.owner.query("SELECT * FROM souvenir_rule")).rows).toEqual([]);
  });
  it("refuses stale activation targets and leaves no partial promise or target rows", async () => {
    const rule = await f.create({ audience: "all" });
    await expect(
      f.run(f.actor, "SELECT souvenir_action($1,$2,'activate',$3,$4)", [
        f.ids.eventA,
        rule,
        randomUUID(),
        [],
      ]),
    ).rejects.toMatchObject({ code: "SV409", detail: "souvenir_changed" });
    expect(
      (await f.db.owner.query("SELECT * FROM souvenir_target WHERE rule_id=$1", [rule])).rows,
    ).toEqual([]);
    await f.run(f.actor, "SELECT souvenir_action($1,$2,'activate',$3,$4)", [
      f.ids.eventA,
      rule,
      randomUUID(),
      [f.quest],
    ]);
    expect(
      (await f.db.owner.query("SELECT * FROM souvenir_target WHERE rule_id=$1", [rule])).rows,
    ).toHaveLength(1);
  });
  it("keeps finisher evidence across a category reset and a later hidden/new quest", async () => {
    await f.complete();
    await f.db.owner.query("UPDATE category SET refresh='daily' WHERE id=$1", [f.category]);
    const rule = await f.create({ audience: "all" });
    await f.action(rule);
    await f.db.owner.query(
      "UPDATE quest_completion SET created_at=now()-interval '2 days' WHERE enrollment_id=$1",
      [f.member],
    );
    await f.db.owner.query(
      `INSERT INTO quest(event_id,category_id,type,title_en,points,type_config)
      VALUES($1,$2,'enter_code','Later',10,'{"code":"XYZ"}')`,
      [f.ids.eventA, f.category],
    );
    expect((await f.grant()).rows[0].n).toBe(1);
  });
});
