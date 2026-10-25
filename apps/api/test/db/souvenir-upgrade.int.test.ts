import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createTestDatabase, seedTwoTenants, TEST_DATABASE_URL } from "#test/support/test-db";
import { blocked } from "#test/support/souvenirs";

async function preSouvenir() {
  const migrations = join(import.meta.dirname, "../../migrations");
  const directory = await mkdtemp(join(tmpdir(), "questify-pre-souvenir-"));
  for (const file of await readdir(migrations))
    if (file < "0064") await cp(join(migrations, file), join(directory, file));
  const db = await createTestDatabase(directory);
  const ids = await seedTwoTenants(db.owner);
  const hash = randomBytes(32);
  await db.owner.query(
    `INSERT INTO player_deletion_challenge(id,token_hash,player_id,contact_key,code_hash,expires_at,deletion_hash,deletion_expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',$6,now()+interval '1 hour')`,
    [randomUUID(), randomBytes(32), ids.playerA, randomBytes(32), randomBytes(32), hash],
  );
  const url = new URL(db.appUrl);
  url.username = "postgres";
  url.password = "postgres";
  const migration = new Client({ connectionString: url.toString() });
  await migration.connect();
  const sql = await readFile(join(migrations, "0064_event_souvenirs.sql"), "utf8");
  const close = async () => {
    await Promise.all([migration.query("ROLLBACK"), db.app.query("ROLLBACK")]);
    await migration.end();
    await db.close();
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("questify-pre-souvenir-")
    )
      throw new Error("unsafe fixture directory");
    await rm(directory, { recursive: true, force: true });
  };
  return { db, ids, hash, migration, sql, close };
}

describe.skipIf(TEST_DATABASE_URL === undefined)("pre-souvenir upgrade boundary", () => {
  it("drains an erasure running the actual0063 function before replacing cleanup", async () => {
    const f = await preSouvenir();
    try {
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT * FROM erase_player($1,true,$2)", [f.hash, randomUUID()]);
      await f.migration.query("BEGIN");
      const pid = (await f.migration.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const upgrade = f.migration.query(f.sql);
      await blocked(f.db.owner, pid);
      await f.db.app.query("COMMIT");
      await upgrade;
      await f.migration.query("COMMIT");
      expect(
        (await f.db.owner.query("SELECT status FROM player WHERE id=$1", [f.ids.playerA])).rows[0]
          .status,
      ).toBe("deleted");
      expect(
        (await f.db.owner.query("SELECT * FROM player_item WHERE player_id=$1", [f.ids.playerA]))
          .rows,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("holds a later erasure until new cleanup and ownership constraints commit", async () => {
    const f = await preSouvenir();
    try {
      await f.migration.query("BEGIN");
      await f.migration.query(f.sql);
      const pid = (await f.db.app.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const erase = f.db.app.query("SELECT * FROM erase_player($1,true,$2)", [
        f.hash,
        randomUUID(),
      ]);
      await blocked(f.db.owner, pid);
      await f.migration.query("COMMIT");
      await erase;
      expect(
        (
          await f.db.owner.query("SELECT * FROM souvenir_receipt WHERE player_id=$1", [
            f.ids.playerA,
          ])
        ).rows,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("waits for a pre-upgrade XP writer and preserves its typed level ownership", async () => {
    const f = await preSouvenir();
    try {
      const category = (
        await f.db.owner.query(
          "INSERT INTO category(event_id,name_en) VALUES($1,'Upgrade') RETURNING id",
          [f.ids.eventA],
        )
      ).rows[0].id;
      const quest = (
        await f.db.owner.query(
          `INSERT INTO quest(event_id,category_id,type,title_en,points,type_config) VALUES($1,$2,'enter_code','Upgrade',10,'{"code":"ABC"}') RETURNING id`,
          [f.ids.eventA, category],
        )
      ).rows[0].id;
      await f.db.owner.query(
        "UPDATE platform_setting SET value=jsonb_build_object('questXp',1000) WHERE key='xp'",
      );
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id',$1,true)", [f.ids.playerA]);
      await f.db.app.query("SELECT * FROM complete_quest($1,'code',NULL,'ABC',$2,NULL)", [
        quest,
        randomUUID(),
      ]);
      await f.migration.query("BEGIN");
      const pid = (await f.migration.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const upgrade = f.migration.query(f.sql);
      await blocked(f.db.owner, pid);
      await f.db.app.query("COMMIT");
      await upgrade;
      await f.migration.query("COMMIT");
      const owned = (
        await f.db.owner.query(
          "SELECT source,source_level,source_rule_id,source_event_id FROM player_item WHERE player_id=$1",
          [f.ids.playerA],
        )
      ).rows;
      expect(owned.length).toBeGreaterThan(0);
      expect(
        owned.every(
          (row) =>
            row.source === "level" &&
            row.source_level !== null &&
            row.source_rule_id === null &&
            row.source_event_id === null,
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
});
