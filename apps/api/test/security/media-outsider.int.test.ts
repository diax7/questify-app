import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { startMediaFixture, linkPath, type MediaFixture } from "#test/storage/media-test-store";
import { startApp, type TestApp } from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  roleUrl,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

const tryConnect = async (url: string): Promise<unknown> => {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    return "connected";
  } catch (error) {
    return (error as { code?: string }).code;
  } finally {
    await client.end().catch(() => undefined);
  }
};

/**
 * The media database's deny by default (T-814, ADR-839) on one server holding both databases: who can connect where,
 * what the media role can run, the main database's two new doors for the system seat only, and the media route's one
 * 404 for every link that is not exactly right, another organizer's key included.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the media database's outsider suite", () => {
  let db: TestDatabase;
  let fixture: MediaFixture;
  let test: TestApp;
  let mainName = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    fixture = await startMediaFixture();
    test = await startApp(db, false, {}, { storage: fixture.store });
    mainName = new URL(db.appUrl).pathname.slice(1);
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
    await db.close();
  });

  it("lets only the media role connect to the media database, and keeps it out of the main one", async () => {
    const media = fixture.media.name;
    expect(await tryConnect(roleUrl(media, "questify_outsider"))).toBe("42501");
    expect(await tryConnect(roleUrl(media, "questify_app"))).toBe("42501");
    expect(await tryConnect(fixture.media.appUrl)).toBe("connected");
    expect(await tryConnect(roleUrl(mainName, "questify_media_app"))).toBe("42501");
    expect(await tryConnect(db.appUrl)).toBe("connected");
  });

  it("gives the media role the four definers and nothing else, and no role a right on media_blob", async () => {
    const owner = fixture.media.owner;
    const { rows } = await owner.query<{ proname: string; media: boolean; definer: boolean }>(
      `SELECT proname, has_function_privilege('questify_media_app', p.oid, 'EXECUTE') AS media,
              prosecdef AS definer
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
       ORDER BY proname`,
    );
    expect(rows).toEqual(
      ["blob_delete", "blob_get", "blob_keys_page", "blob_put"].map((proname) => ({
        proname,
        media: true,
        definer: true,
      })),
    );
    const grants = await owner.query(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_name IN ('media_blob', 'schema_migration') AND grantee <> current_user`,
    );
    expect(grants.rows).toEqual([]);
    const app = new Client({ connectionString: fixture.media.appUrl });
    await app.connect();
    try {
      for (const sql of [
        "SELECT * FROM media_blob",
        "INSERT INTO media_blob (key) VALUES ('x')",
        "DELETE FROM media_blob",
        "SELECT * FROM schema_migration",
      ]) {
        await expect(app.query(sql), sql).rejects.toMatchObject({ code: "42501" });
      }
      expect((await app.query("SELECT * FROM blob_keys_page(NULL, now(), 1)")).rows).toEqual([]);
    } finally {
      await app.end();
    }
  });

  it("opens media_keys_known and media_reconcile_claim to the system seat only", async () => {
    const tenants = await seedTwoTenants(db.owner);
    const seats: RequestContext[] = [
      { playerId: tenants.playerA },
      { staffUserId: randomUUID(), organizerId: tenants.orgA },
      { staffUserId: randomUUID(), isAdmin: true },
    ];
    for (const seat of seats) {
      for (const sql of [
        "SELECT * FROM media_keys_known(ARRAY['k'])",
        "SELECT media_reconcile_claim()",
      ]) {
        await expect(
          withRequestContext(db.app, seat, () => db.app.query(sql)),
          `${sql} ${JSON.stringify(seat)}`,
        ).rejects.toMatchObject({ code: "42501" });
      }
    }
    for (const sql of [
      "SELECT * FROM public.media_keys_known(ARRAY['k'])",
      "SELECT public.media_reconcile_claim()",
      "SELECT * FROM public.media_reconcile_run",
    ]) {
      await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
    }
    const asked = await withRequestContext(db.app, {}, () =>
      db.app.query("SELECT * FROM media_keys_known(ARRAY['b', 'a', 'a'])"),
    );
    expect(asked.rows).toEqual([
      { key: "a", known: false },
      { key: "b", known: false },
    ]);
    await expect(
      withRequestContext(db.app, {}, () =>
        db.app.query("SELECT * FROM media_keys_known($1::text[])", [
          Array.from({ length: 501 }, (_, n) => `k${n}`),
        ]),
      ),
    ).rejects.toMatchObject({ code: "MD422" });
  });

  it("answers the same 404 for every link that is not exactly the one signed, another organizer's key included", async () => {
    const org = randomUUID();
    const event = randomUUID();
    const mine = `o/${org}/e/${event}/submission/${randomUUID()}.jpg`;
    const theirs = `o/${randomUUID()}/e/${randomUUID()}/submission/${randomUUID()}.jpg`;
    await fixture.store.put(mine, Buffer.from("mine"));
    await fixture.store.put(theirs, Buffer.from("theirs"));
    const good = linkPath(fixture.store.signGet(mine, 300).url);
    const [path, query] = good.split("?");
    const hour = Math.floor(Date.now() / 1000) + 3600;
    const expired = linkPath(fixture.store.signGet(mine, 1, new Date(Date.now() - 10_000)).url);
    const refusals = [
      String(path),
      `/v1/media/${theirs}?${query}`,
      `${path}?e=${hour}&${String(query).split("&")[1]}`,
      expired,
      `/v1/media/${mine.replace(/\//g, "%2f")}?${query}`,
      `/v1/media/${mine}/extra?${query}`,
      `/v1/media/${mine.replace(".jpg", ".png")}?${query}`,
    ];
    const bodies = new Set<string>();
    for (const url of refusals) {
      const refused = await test.app.inject({ method: "GET", url });
      expect(refused.statusCode, url).toBe(404);
      bodies.add(refused.body);
      expect(refused.body).not.toContain(org);
    }
    expect(bodies.size).toBe(1);
    const served = await test.app.inject({ method: "GET", url: good });
    expect([served.statusCode, served.body]).toEqual([200, "mine"]);
  });
});
