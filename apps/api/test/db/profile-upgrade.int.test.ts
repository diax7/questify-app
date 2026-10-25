import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve as resolvePath, join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

const migrations = join(import.meta.dirname, "../../migrations");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "questify-pre-profile-"));
  for (const file of await readdir(migrations)) {
    if (file < "0063") await cp(join(migrations, file), join(directory, file));
  }
  const db = await createTestDatabase(directory);
  const ids = await seedTwoTenants(db.owner);
  const category = (
    await db.owner.query(
      "INSERT INTO category(event_id,name_en) VALUES($1,'Upgrade') RETURNING id",
      [ids.eventA],
    )
  ).rows[0].id;
  const quest = (
    await db.owner.query(
      `INSERT INTO quest(event_id,category_id,type,title_en,points,type_config) VALUES($1,$2,'enter_code','Upgrade',10,'{"code":"ABC"}') RETURNING id`,
      [ids.eventA, category],
    )
  ).rows[0].id;
  await db.owner.query(
    "UPDATE platform_setting SET value=jsonb_build_object('questXp',1000) WHERE key='xp'",
  );
  await withRequestContext(db.app, { playerId: ids.playerA }, () =>
    db.app.query("SELECT * FROM complete_quest($1,'code',NULL,'ABC',$2,NULL)", [
      quest,
      randomUUID(),
    ]),
  );
  const hash = randomBytes(32);
  await db.owner.query(
    `INSERT INTO player_deletion_challenge(id,token_hash,player_id,contact_key,code_hash,expires_at,deletion_hash,deletion_expires_at)
   VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',$6,now()+interval '1 hour')`,
    [randomUUID(), randomBytes(32), ids.playerA, randomBytes(32), randomBytes(32), hash],
  );
  const ownerUrl = new URL(db.appUrl);
  ownerUrl.username = "postgres";
  ownerUrl.password = "postgres";
  const migration = new Client({ connectionString: ownerUrl.toString() });
  await migration.connect();
  const sql = await readFile(join(migrations, "0063_profile_items.sql"), "utf8");
  return {
    db,
    ids,
    quest,
    hash,
    migration,
    sql,
    close: async () => {
      await Promise.all([db.app.query("ROLLBACK"), migration.query("ROLLBACK")]);
      await migration.end();
      await db.close();
      if (
        dirname(resolvePath(directory)) !== resolvePath(tmpdir()) ||
        !basename(directory).startsWith("questify-pre-profile-")
      )
        throw new Error("unsafe temporary fixture path");
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function blocked(observer: Client, pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      (
        await observer.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
          [pid],
        )
      ).rowCount === 1
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("expected upgrade lock was never observed");
}
async function absent(db: Awaited<ReturnType<typeof fixture>>["db"], player: string) {
  for (const table of ["player_item", "player_equipment"])
    expect(
      (await db.owner.query(`SELECT * FROM ${table} WHERE player_id=$1`, [player])).rows,
    ).toEqual([]);
  expect(
    (await db.owner.query("SELECT * FROM level_reached WHERE player_id=$1", [player])).rows,
  ).toHaveLength(3);
}
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "profile migration versus pre-upgrade erasure",
  () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => {
      f = await fixture();
    });
    afterEach(async () => {
      await f?.close();
    });
    it("drains the old erasure before taking the backfill snapshot", async () => {
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT * FROM erase_player($1,true,$2)", [f.hash, randomUUID()]);
      await f.migration.query("BEGIN");
      const pid = (await f.migration.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const upgrading = f.migration.query(f.sql);
      await blocked(f.db.owner, pid);
      await f.db.app.query("COMMIT");
      await upgrading;
      await f.migration.query("COMMIT");
      await absent(f.db, f.ids.playerA);
    });
    it("holds a connection from the old schema until new cleanup is visible", async () => {
      await f.migration.query("BEGIN");
      await f.migration.query(f.sql);
      const pid = (await f.db.app.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await f.db.app.query("BEGIN");
      const erasing = f.db.app.query("SELECT * FROM erase_player($1,true,$2)", [
        f.hash,
        randomUUID(),
      ]);
      await blocked(f.db.owner, pid);
      await f.migration.query("COMMIT");
      await erasing;
      await f.db.app.query("COMMIT");
      await absent(f.db, f.ids.playerA);
    });
    it("drains an in-flight XP writer before the reached barrier without a player/XP cycle", async () => {
      const next = (
        await f.db.owner.query(
          `INSERT INTO quest(event_id,category_id,type,title_en,points,type_config)
   SELECT event_id,category_id,type,'Next',points,type_config FROM quest WHERE id=$1 RETURNING id`,
          [f.quest],
        )
      ).rows[0].id;
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id',$1,true)", [f.ids.playerA]);
      await f.db.app.query("SELECT * FROM complete_quest($1,'code',NULL,'ABC',$2,NULL)", [
        next,
        randomUUID(),
      ]);
      await f.migration.query("BEGIN");
      const pid = (await f.migration.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const upgrading = f.migration.query(f.sql);
      await blocked(f.db.owner, pid);
      expect(
        (
          await f.db.owner.query(
            `SELECT relation::regclass::text AS name FROM pg_locks WHERE pid=$1 AND NOT granted`,
            [pid],
          )
        ).rows,
      ).toContainEqual({ name: "player_xp" });
      await f.db.app.query("COMMIT");
      await upgrading;
      await f.migration.query("COMMIT");
      const owned = (
        await f.db.owner.query(
          "SELECT source_level FROM player_item WHERE player_id=$1 ORDER BY source_level",
          [f.ids.playerA],
        )
      ).rows;
      expect(owned.map((row) => row.source_level)).toEqual([2, 3, 4, 5, 6]);
    });
  },
);
