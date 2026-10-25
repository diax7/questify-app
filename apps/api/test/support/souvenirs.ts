import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { createTestDatabase, seedTwoTenants, addMember } from "#test/support/test-db";

export async function souvenirFixture() {
  const db = await createTestDatabase();
  const ids = await seedTwoTenants(db.owner);
  const staff = await addMember(db.owner, ids.orgA);
  const pool = new Pool({ connectionString: db.appUrl, max: 8 });
  const actor = { organizerId: ids.orgA, staffUserId: staff };
  const run = async (context: RequestContext, sql: string, values: unknown[] = []) => {
    const client = await pool.connect();
    try {
      return await withRequestContext(client, context, () => client.query(sql, values));
    } finally {
      client.release();
    }
  };
  const member = (
    await db.owner.query("SELECT id FROM enrollment WHERE player_id=$1", [ids.playerA])
  ).rows[0].id as string;
  const category = (
    await db.owner.query(
      "INSERT INTO category(event_id,name_en) VALUES($1,'Souvenirs') RETURNING id",
      [ids.eventA],
    )
  ).rows[0].id as string;
  const quest = (
    await db.owner.query(
      `INSERT INTO quest(event_id,category_id,type,title_en,points,type_config)
    VALUES($1,$2,'enter_code','Souvenir quest',10,'{"code":"ABC"}') RETURNING id`,
      [ids.eventA, category],
    )
  ).rows[0].id as string;
  const body = {
    kind: "frame",
    name: { ar: "تذكار الرحلة", en: "Journey souvenir" },
    visualKey: "frame-01",
    audience: "joined",
    categoryId: null,
    rankFrom: null,
    rankTo: null,
  };
  const create = async (overrides: Record<string, unknown> = {}, request = randomUUID()) => {
    const rows = await run(actor, "SELECT souvenir_save($1,NULL,$2,$3) AS id", [
      ids.eventA,
      { ...body, ...overrides },
      request,
    ]);
    return rows.rows[0].id as string;
  };
  const action = (rule: string, verb = "activate", request = randomUUID()) =>
    run(actor, "SELECT souvenir_action($1,$2,$3,$4)", [ids.eventA, rule, verb, request]);
  const grant = () => run({}, "SELECT souvenir_evaluate($1) AS n", [member]);
  const complete = () =>
    run({ playerId: ids.playerA }, "SELECT * FROM complete_quest($1,'code',NULL,'ABC',$2,NULL)", [
      quest,
      randomUUID(),
    ]);
  const owned = () =>
    db.owner.query("SELECT * FROM player_item WHERE player_id=$1 AND source='souvenir'", [
      ids.playerA,
    ]);
  const deletion = async () => {
    const hash = randomBytes(32);
    await db.owner.query(
      `INSERT INTO player_deletion_challenge(id,token_hash,player_id,contact_key,code_hash,expires_at,deletion_hash,deletion_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',$6,now()+interval '1 hour')`,
      [randomUUID(), randomBytes(32), ids.playerA, randomBytes(32), randomBytes(32), hash],
    );
    return hash;
  };
  return {
    db,
    ids,
    pool,
    actor,
    staff,
    member,
    category,
    quest,
    body,
    run,
    create,
    action,
    grant,
    complete,
    owned,
    deletion,
    close: async () => {
      await pool.end();
      await db.close();
    },
  };
}

export async function blocked(observer: { query: PoolClient["query"] }, pid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await observer.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [
      pid,
    ]);
    if (rows.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("expected a blocked database statement");
}
