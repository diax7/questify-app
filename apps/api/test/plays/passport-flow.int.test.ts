import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "#src/auth/sign-in";
import { readPassport, stampStep, type PassportDeps } from "#src/passport/stamp";
import { createStepCodeKey, stepCode } from "#src/quests/qr";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Logged = Readonly<{ event: string; fields: Record<string, unknown> }>;

const STEP_KEY = createStepCodeKey("p".repeat(40));

/**
 * The stamp flow below the route (T-304b): what it logs for each outcome (never the code), the device it records, and
 * the passport read. The route's own tests cover the answers.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the passport stamp flow", () => {
  let db: TestDatabase;
  let pool: Pool;
  let deps: PassportDeps;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
    deps = { pool, stepKey: STEP_KEY };
    ids = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newPlayer = async (): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`stamp_flow_${counter}`],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      ids.orgA,
      ids.eventA,
      player?.id,
    ]);
    return player?.id ?? "";
  };

  /** A passport on the live event A with two steps needing both, in one transaction as the builder writes it. */
  const newPassport = async (): Promise<{ quest: string; steps: string[] }> => {
    await owner("BEGIN");
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, verification)
       SELECT $1, id, 'passport', 'Booths', 20, '{"needed": 2}', '{}' FROM category WHERE event_id = $1 LIMIT 1
       RETURNING id`,
      [ids.eventA],
    );
    const steps: string[] = [];
    for (const position of [0, 1]) {
      const [step] = await owner<{ id: string }>(
        "INSERT INTO passport_step (event_id, quest_id, name_en, position) VALUES ($1, $2, $3, $4) RETURNING id",
        [ids.eventA, quest?.id, `Booth ${position}`, position],
      );
      steps.push(step?.id ?? "");
    }
    await owner("COMMIT");
    return { quest: quest?.id ?? "", steps };
  };

  const stamp = async (
    player: string,
    stepId: string,
    code: string = stepCode(STEP_KEY, stepId, 1),
    deviceId: string | undefined = undefined,
  ) => {
    const logged: Logged[] = [];
    const caller: Caller = {
      address: "127.0.0.1",
      userAgent: null,
      requestId: undefined,
      log: (event, fields) => logged.push({ event, fields: { ...fields } }),
    };
    const result = await stampStep(
      deps,
      { playerId: player, stepId, code, idempotencyKey: randomUUID(), deviceId },
      caller,
    );
    return { result, logged };
  };

  describe("what it logs", () => {
    it("logs each stamp with its quest and whether it paid", async () => {
      const player = await newPlayer();
      const { quest, steps } = await newPassport();
      const first = await stamp(player, steps[0] ?? "");
      expect(first.result).toMatchObject({ kind: "done", value: { stamped: true, done: 1 } });
      expect(first.logged).toEqual([
        { event: "passport.stamped", fields: { questId: quest, paid: "false" } },
      ]);
      const second = await stamp(player, steps[1] ?? "");
      expect(second.result).toMatchObject({ kind: "done", value: { done: 2 } });
      expect(second.logged).toEqual([
        { event: "passport.stamped", fields: { questId: quest, paid: "true" } },
      ]);
    });

    it.each([
      [
        "a forged code, refused before the database",
        (step: string) => stepCode(createStepCodeKey("x".repeat(40)), step, 1),
        "forged",
      ],
      [
        "another step's code, refused before the database",
        () => stepCode(STEP_KEY, randomUUID(), 1),
        "wrong_step",
      ],
      [
        "a code from before a regenerate, refused by the database",
        (step: string) => stepCode(STEP_KEY, step, 4),
        "old",
      ],
    ] as const)("logs %s with its own reason, never the code", async (_name, codeFor, reason) => {
      const player = await newPlayer();
      const { steps } = await newPassport();
      const step = steps[0] ?? "";
      const code = codeFor(step);
      const { result, logged } = await stamp(player, step, code);
      expect(result).toEqual({ kind: "invalid_code", problem: reason });
      expect(logged).toEqual([
        { event: "passport.refused", fields: { stepId: step, refusal: "invalid_code", reason } },
      ]);
      expect(JSON.stringify(logged)).not.toContain(code);
    });

    it("logs a closed quest and an inactive enrollment with their reasons, and other refusals by kind", async () => {
      const player = await newPlayer();
      const hidden = await newPassport();
      await owner("UPDATE quest SET visible = false WHERE id = $1", [hidden.quest]);
      const step = hidden.steps[0] ?? "";
      expect((await stamp(player, step)).logged).toEqual([
        {
          event: "passport.refused",
          fields: { stepId: step, refusal: "quest_not_open", reason: "hidden" },
        },
      ]);
      const missing = randomUUID();
      expect((await stamp(player, missing)).logged).toEqual([
        {
          event: "passport.refused",
          fields: { stepId: missing, refusal: "not_found", reason: "not_found" },
        },
      ]);
      const open = await newPassport();
      const openStep = open.steps[0] ?? "";
      await owner("UPDATE enrollment SET status = 'left' WHERE player_id = $1", [player]);
      expect((await stamp(player, openStep)).logged).toEqual([
        {
          event: "passport.refused",
          fields: { stepId: openStep, refusal: "enrollment_inactive", reason: "left" },
        },
      ]);
    });
  });

  it("records the app's install id with the stamp, and none when the app sent none", async () => {
    const player = await newPlayer();
    const { steps } = await newPassport();
    const device = randomUUID();
    await stamp(player, steps[0] ?? "", undefined, device);
    await stamp(player, steps[1] ?? "");
    expect(
      await owner("SELECT step_id, device_id FROM passport_stamp WHERE step_id = ANY ($1)", [
        steps,
      ]),
    ).toEqual(
      expect.arrayContaining([
        { step_id: steps[0], device_id: device },
        { step_id: steps[1], device_id: null },
      ]),
    );
  });

  it("reads a passport with each step and whether this player stamped it, and not found for a stranger", async () => {
    const player = await newPlayer();
    const { quest, steps } = await newPassport();
    await stamp(player, steps[1] ?? "");
    expect(await readPassport(deps, player, quest)).toEqual({
      kind: "done",
      value: {
        needed: 2,
        steps: [
          { id: steps[0], name: { ar: null, en: "Booth 0" }, done: false },
          { id: steps[1], name: { ar: null, en: "Booth 1" }, done: true },
        ],
      },
    });
    expect(await readPassport(deps, ids.playerB, quest)).toEqual({ kind: "not_found" });
  });
});
