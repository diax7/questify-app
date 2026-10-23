import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readShare, shareQuest, type ShareDeps } from "#src/plays/shares";
import type { ConfigResult, SettingsService } from "#src/settings/service";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/** The composed configuration with share quests switched on or off above the event (the platform's switch, T-007). */
const settingsWith = (shareQuests: boolean): SettingsService =>
  ({
    forEvent: async (): Promise<ConfigResult> =>
      ({
        kind: "ok",
        config: { features: { shareQuests: { enabled: shareQuests } } },
        etag: "x",
      }) as unknown as ConfigResult,
  }) as unknown as SettingsService;

/**
 * Share quests under the composed switch (T-303, FR-219): the event's own switch is on in the database, so only the
 * API's composed configuration hides the quest and refuses paying it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("share quests under the composed switch", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let quest = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
    ids = await seedTwoTenants(db.owner);
    const [made] = (
      await db.owner.query<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, 'share', 'Share', 10, $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [
          ids.eventA,
          JSON.stringify({ message: { en: "At the fest" }, link: "https://example.com/fest" }),
        ],
      )
    ).rows;
    quest = made?.id ?? "";
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const deps = (shareQuests: boolean): ShareDeps => ({ pool, settings: settingsWith(shareQuests) });

  it("hides the quest and refuses paying it while the composed switch is off", async () => {
    expect(await readShare(deps(false), ids.playerA, quest)).toEqual({ kind: "not_found" });
    expect(
      await shareQuest(deps(false), {
        playerId: ids.playerA,
        questId: quest,
        idempotencyKey: randomUUID(),
      }),
    ).toEqual({ kind: "feature_off" });
  });

  it("shows and pays it while the composed switch is on", async () => {
    expect(await readShare(deps(true), ids.playerA, quest)).toEqual({
      kind: "done",
      value: {
        message: { ar: null, en: "At the fest" },
        link: "https://example.com/fest",
        done: false,
      },
    });
    expect(
      await shareQuest(deps(true), {
        playerId: ids.playerA,
        questId: quest,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ kind: "done", value: { points: 10 } });
  });
});
