import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { readLocker } from "#src/players/items";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

describe.skipIf(TEST_DATABASE_URL === undefined)("profile ownership boundary", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let serial = 0;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
    ids = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });
  const as = async (id: string, sql: string, values: unknown[] = []) => {
    const client = await pool.connect();
    try {
      return await withRequestContext(client, { playerId: id }, () => client.query(sql, values));
    } finally {
      client.release();
    }
  };
  const seed = async (xp = 1000) => {
    serial += 1;
    const player = (
      await db.owner.query("INSERT INTO player(username) VALUES($1) RETURNING id", [
        `locker_${serial}`,
      ])
    ).rows[0].id as string;
    await db.owner.query(
      "INSERT INTO enrollment(organizer_id,event_id,player_id) VALUES($1,$2,$3)",
      [ids.orgA, ids.eventA, player],
    );
    const category = (
      await db.owner.query(
        "INSERT INTO category(event_id,name_en) VALUES($1,'Locker') RETURNING id",
        [ids.eventA],
      )
    ).rows[0].id;
    const quest = (
      await db.owner.query(
        `INSERT INTO quest(event_id,category_id,type,title_en,points,type_config) VALUES($1,$2,'enter_code','Locker',10,'{"code":"ABC"}') RETURNING id`,
        [ids.eventA, category],
      )
    ).rows[0].id;
    await db.owner.query(
      "UPDATE platform_setting SET value=jsonb_build_object('questXp',$1::int) WHERE key='xp'",
      [xp],
    );
    const completed = await as(
      player,
      "SELECT * FROM complete_quest($1,'code',NULL,'ABC',$2,NULL)",
      [quest, randomUUID()],
    );
    return { player, quest, completion: completed.rows[0].completion_id as string };
  };
  const owned = (player: string) =>
    db.owner.query("SELECT item_id FROM player_item WHERE player_id=$1 ORDER BY source_level", [
      player,
    ]);
  const equip = (player: string, patch: object) =>
    as(player, "SELECT equip_player($1)", [JSON.stringify(patch)]);
  const token = async (player: string) => {
    const hash = randomBytes(32);
    await db.owner.query(
      `INSERT INTO player_deletion_challenge(id,token_hash,player_id,contact_key,code_hash,expires_at,deletion_hash,deletion_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',$6,now()+interval '1 hour')`,
      [randomUUID(), randomBytes(32), player, randomBytes(32), randomBytes(32), hash],
    );
    return hash;
  };

  it("maps every level and grants each crossed level once with replayable completion items", async () => {
    expect(
      (
        await db.owner.query(
          "SELECT level FROM xp_level WHERE level>1 EXCEPT SELECT level FROM level_item",
        )
      ).rows,
    ).toEqual([]);
    const { player, completion } = await seed();
    expect((await owned(player)).rows).toEqual([
      { item_id: "level-2" },
      { item_id: "level-3" },
      { item_id: "level-4" },
    ]);
    await db.owner.query("SELECT backfill_level_items(); SELECT backfill_level_items()");
    const read = () => as(player, "SELECT own_level_items($1) AS items", [completion]);
    expect((await read()).rows[0].items.map((x: { id: string }) => x.id)).toEqual([
      "level-2",
      "level-3",
      "level-4",
    ]);
    expect((await read()).rows).toEqual((await read()).rows);
    expect(
      (await as(ids.playerB, "SELECT own_level_items($1) AS items", [completion])).rows[0].items,
    ).toEqual([]);
  });

  it("pages equal timestamps without losing their PostgreSQL microseconds", async () => {
    const { player } = await seed(99999);
    const client = await pool.connect();
    try {
      const collected: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await withRequestContext(client, { playerId: player }, () =>
          readLocker(client, cursor, 1),
        );
        collected.push(...page.items.map((row) => row.item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(collected).toHaveLength(29);
      expect(new Set(collected).size).toBe(29);
    } finally {
      client.release();
    }
  });

  it.each(["equip-first", "erase-first", "seen-first", "erase-before-seen"])(
    "orders erasure and private mutations: %s",
    async (order) => {
      const { player } = await seed();
      const hash = await token(player);
      const first = await pool.connect(),
        second = await pool.connect();
      const erase = ["SELECT * FROM erase_player($1,true,$2)", [hash, randomUUID()]] as const;
      const mutation = order.includes("seen")
        ? (["SELECT see_owned_items($1)", [["level-2"]]] as const)
        : (["SELECT equip_player($1)", [JSON.stringify({ frameId: "level-2" })]] as const);
      const eraseFirst = order.startsWith("erase");
      const before = eraseFirst ? erase : mutation,
        after = eraseFirst ? mutation : erase;
      let pending: Promise<unknown> | undefined;
      try {
        await first.query("BEGIN");
        await first.query("SELECT set_config('app.player_id',$1,true)", [player]);
        await first.query(before[0], [...before[1]]);
        const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        pending = withRequestContext(second, { playerId: player }, () =>
          second.query(after[0], [...after[1]]),
        ).then(
          () => null,
          (error) => error,
        );
        let waited = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (
            (
              await db.owner.query(
                "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
                [pid],
              )
            ).rowCount === 1
          ) {
            waited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waited).toBe(true);
        await first.query("COMMIT");
        const outcome = await pending;
        if (eraseFirst) expect(outcome).toMatchObject({ code: "PI401" });
        else expect(outcome).toBeNull();
        expect((await owned(player)).rows).toEqual([]);
        expect(
          (await db.owner.query("SELECT * FROM player_equipment WHERE player_id=$1", [player]))
            .rows,
        ).toEqual([]);
      } finally {
        await first.query("ROLLBACK");
        await pending;
        await second.query("ROLLBACK");
        first.release();
        second.release();
      }
    },
  );
  it("enforces ownership and kind, keeps unspecified slots, and selecting a starter clears earned character", async () => {
    const { player } = await seed();
    await equip(player, { frameId: "level-2", titleId: "level-3", characterId: "level-4" });
    for (const patch of [
      { frameId: "level-3" },
      { frameId: "missing" },
      { titleId: "level-2" },
      { characterId: "level-2" },
    ]) {
      await expect(equip(player, patch)).rejects.toMatchObject({ code: "PI422" });
    }
    await expect(equip(ids.playerB, { frameId: "level-2" })).rejects.toMatchObject({
      code: "PI422",
    });
    await equip(player, { avatar: "fox" });
    const equipment = (await as(player, "SELECT equipment FROM own_equipment()")).rows[0].equipment;
    expect(equipment).toMatchObject({
      character: null,
      frame: { id: "level-2" },
      title: { id: "level-3" },
    });
    await equip(player, { frameId: null, titleId: null });
    expect((await as(player, "SELECT equipment FROM own_equipment()")).rows[0].equipment).toEqual({
      character: null,
      frame: null,
      title: null,
    });
    await expect(
      as(player, "UPDATE player SET avatar='camel' WHERE id=$1", [player]),
    ).rejects.toThrow(/permission denied/);
  });
  it("serializes concurrent edits without losing an unrelated slot", async () => {
    const { player } = await seed();
    await Promise.all([
      equip(player, { frameId: "level-2" }),
      equip(player, { titleId: "level-3" }),
    ]);
    expect(
      (await as(player, "SELECT equipment FROM own_equipment()")).rows[0].equipment,
    ).toMatchObject({ frame: { id: "level-2" }, title: { id: "level-3" } });
  });
  it("reads and acknowledges only owned inventory; refuses every direct and internal write", async () => {
    const { player } = await seed();
    expect((await as(ids.playerB, "SELECT * FROM own_locker(NULL,NULL,101)")).rows).toEqual([]);
    await as(ids.playerB, "SELECT see_owned_items($1)", [["level-2"]]);
    expect(
      (await as(player, "SELECT * FROM own_locker(NULL,NULL,101)")).rows.every((x) => !x.seen),
    ).toBe(true);
    await as(player, "SELECT see_owned_items($1)", [["level-2"]]);
    await as(player, "SELECT see_owned_items($1)", [["level-2"]]);
    expect(
      (await as(player, "SELECT * FROM own_locker(NULL,NULL,101)")).rows.find(
        (x) => x.item.id === "level-2",
      ).seen,
    ).toBe(true);
    for (const table of ["item", "level_item", "player_item", "player_equipment"]) {
      for (const sql of [
        `SELECT * FROM ${table}`,
        `DELETE FROM ${table}`,
        `INSERT INTO ${table} DEFAULT VALUES`,
      ]) {
        await expect(as(player, sql)).rejects.toThrow(/permission denied/);
      }
    }
    for (const sql of [
      "SELECT item_json('level-2')",
      "SELECT backfill_level_items()",
      "SELECT profile_player()",
    ])
      await expect(as(player, sql)).rejects.toThrow(/permission denied/);
    await expect(
      db.owner.query("UPDATE player_item SET earned_at=now() WHERE player_id=$1", [player]),
    ).rejects.toThrow(/earned items/);
    await expect(
      db.owner.query("DELETE FROM player_item WHERE player_id=$1", [player]),
    ).rejects.toThrow(/earned items/);
    await expect(
      db.owner.query("UPDATE item SET kind='character' WHERE id='level-3'"),
    ).rejects.toThrow(/immutable/);
  });
  it("fails a missing reward atomically instead of paying XP without an item", async () => {
    const { player, quest } = await seed(100);
    await db.owner.query("INSERT INTO xp_level(level,xp_from) VALUES(31,49000)");
    try {
      await db.owner.query(
        "UPDATE platform_setting SET value=jsonb_build_object('questXp',99999) WHERE key='xp'",
      );
      const category = (await db.owner.query("SELECT category_id FROM quest WHERE id=$1", [quest]))
        .rows[0].category_id;
      const next = (
        await db.owner.query(
          `INSERT INTO quest(event_id,category_id,type,title_en,points,type_config) VALUES($1,$2,'enter_code','Next',10,'{"code":"ABC"}') RETURNING id`,
          [ids.eventA, category],
        )
      ).rows[0].id;
      await expect(
        as(player, "SELECT * FROM complete_quest($1,'code',NULL,'ABC',$2,NULL)", [
          next,
          randomUUID(),
        ]),
      ).rejects.toThrow(/mapping/);
      expect(
        (await db.owner.query("SELECT xp FROM player_xp WHERE player_id=$1", [player])).rows[0].xp,
      ).toBe("100");
    } finally {
      await db.owner.query("DELETE FROM xp_level WHERE level=31");
    }
  });
  it("deletes cosmetics while retaining XP/reached; backfill never resurrects erased ownership", async () => {
    const { player } = await seed();
    await equip(player, { characterId: "level-4", frameId: "level-2" });
    const hash = await token(player);
    await as(player, "SELECT * FROM erase_player($1,true,$2)", [hash, randomUUID()]);
    await db.owner.query("SELECT backfill_level_items()");
    expect((await owned(player)).rows).toEqual([]);
    expect(
      (await db.owner.query("SELECT * FROM player_equipment WHERE player_id=$1", [player])).rows,
    ).toEqual([]);
    expect(
      (await db.owner.query("SELECT level FROM level_reached WHERE player_id=$1", [player])).rows,
    ).toHaveLength(3);
    expect(
      (await as(ids.playerB, "SELECT public_player_profile($1) AS p", [`locker_${serial}`])).rows[0]
        .p,
    ).toBeNull();
  });
});
