import { TUNING } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { readTuning } from "#src/settings/tuning";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/** The database function that reads each console tuning number, and the answer it gives. */
const READERS = {
  rehearsalCap: "SELECT rehearsal_cap() AS v",
  flagBurstCount: "SELECT burst_count AS v FROM flag_tuning()",
  flagBurstMinutes: "SELECT extract(epoch FROM burst_window)::int / 60 AS v FROM flag_tuning()",
} as const;
const NUMBERS = Object.keys(READERS) as (keyof typeof READERS)[];

const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => `${error.code}`,
  );

/**
 * The tuning numbers the database reads (T-703, migration 0125): the rehearsal cap, the flag burst numbers and the
 * readiness look-ahead follow `platform_setting` `tuning`, and a stored number nobody may use gives the shipped one.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("platform tuning numbers (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};

  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('tuning@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: row?.id ?? "" };
  });
  afterAll(async () => {
    await f.close();
  });

  const store = (tuning: unknown) =>
    f.owner(
      `INSERT INTO platform_setting (key, value) VALUES ('tuning', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(tuning)],
    );
  const read = async (name: keyof typeof READERS): Promise<number> =>
    Number((await f.owner<{ v: number }>(READERS[name]))[0]?.v);

  it("gives the shipped numbers when nothing is stored", async () => {
    await f.owner("DELETE FROM platform_setting WHERE key = 'tuning'");
    for (const name of NUMBERS) {
      expect(await read(name), name).toBe(TUNING[name]?.default);
    }
  });

  it("follows the stored numbers", async () => {
    await store({ rehearsalCap: 40, flagBurstCount: 20, flagBurstMinutes: 15 });
    expect(await read("rehearsalCap")).toBe(40);
    expect(await read("flagBurstCount")).toBe(20);
    expect(await read("flagBurstMinutes")).toBe(15);
  });

  it.each(NUMBERS)(
    "uses the same range as the registry for %s, to the last whole number",
    async (name) => {
      const { min, max, default: shipped } = TUNING[name] ?? { min: 0, max: 0, default: 0 };
      for (const [stored, expected] of [
        [min, min],
        [max, max],
        [min - 1, shipped],
        [max + 1, shipped],
      ] as const) {
        await store({ [name]: stored });
        expect(await read(name), `${name} stored as ${stored}`).toBe(expected);
      }
    },
  );

  it.each([
    ["a fraction", 7.5],
    ["a text", "9"],
    ["null", null],
    ["a negative number", -3],
    ["a number too large for a whole number", 12345678901],
  ])("gives the shipped number for %s", async (_name, stored) => {
    await store({ rehearsalCap: stored, flagBurstCount: stored, flagBurstMinutes: stored });
    for (const name of NUMBERS) {
      expect(await read(name), name).toBe(TUNING[name]?.default);
    }
  });

  it("reads the same number in the server as in the database", async () => {
    for (const stored of [undefined, 40, 0, 101, 7.5, "9", null]) {
      await store(stored === undefined ? {} : { rehearsalCap: stored });
      expect(await readTuning(f.db.owner, "rehearsalCap"), String(stored)).toBe(
        await read("rehearsalCap"),
      );
    }
  });

  it("changes which events the readiness list looks ahead to", async () => {
    const ahead = await f.newEvent({ phase: "scheduled" });
    await f.owner(
      "UPDATE event SET starts_at = now() + interval '30 days', ends_at = now() + interval '31 days' WHERE id = $1",
      [ahead],
    );
    const ids = async (): Promise<string[]> =>
      (
        (
          await f.run<{ answer: { events: { id: string }[] } }>(
            admin,
            "SELECT readiness_soon() AS answer",
          )
        )[0]?.answer.events ?? []
      ).map((event) => event.id);

    await store({});
    expect(await ids()).not.toContain(ahead);
    await store({ readinessDays: 40 });
    expect(await ids()).toContain(ahead);
    await store({ readinessDays: 20 });
    expect(await ids()).not.toContain(ahead);
    await store({ readinessDays: 0 });
    expect(await ids()).not.toContain(ahead);
  });

  it("keeps the internal reader out of the API role's reach", async () => {
    for (const seat of [admin, f.team(), {}]) {
      expect(
        await refusal(f.run(seat, "SELECT platform_tuning_int('rehearsalCap', 25, 1, 100)")),
      ).toBe("42501");
    }
  });
});
