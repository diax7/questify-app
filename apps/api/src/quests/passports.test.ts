import { PASSPORT_STEPS_MAX } from "@questify/shared";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { passportSteps } from "#src/quests/passports";
import type { QuestFields, QuestRecord } from "#src/quests/store";

const ONE = "11111111-1111-4111-8111-111111111111";
const TWO = "22222222-2222-4222-8222-222222222222";
const THREE = "33333333-3333-4333-8333-333333333333";

/** A database whose `stamped_steps` answers these step ids; the only query passportSteps makes. */
const stampedDb = (stamped: readonly string[] = []): PoolClient =>
  ({
    query: async () => ({ rows: stamped.map((id) => ({ step_id: id })) }),
  }) as unknown as PoolClient;

const fields = (needed: number): QuestFields => ({ config: { needed } }) as unknown as QuestFields;

/** A stored passport with steps ONE, TWO, THREE needing `needed`. */
const stored = (needed: number): QuestRecord =>
  ({
    id: "44444444-4444-4444-8444-444444444444",
    config: { needed },
    steps: [ONE, TWO, THREE].map((id, position) => ({
      id,
      name: { ar: null, en: `Step ${position}` },
      position,
      qrVersion: 1,
    })),
  }) as unknown as QuestRecord;

const named = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: { en: `Booth ${i}` } }));

describe("passportSteps (T-304b)", () => {
  describe("a new passport", () => {
    it("takes 1 step, and exactly the most steps a passport may have", async () => {
      for (const count of [1, PASSPORT_STEPS_MAX]) {
        const checked = await passportSteps(
          stampedDb(),
          undefined,
          "passport",
          fields(1),
          named(count),
        );
        expect(checked).toMatchObject({ kind: "steps" });
        expect(checked.kind === "steps" ? checked.steps?.length : 0).toBe(count);
      }
    });

    it("refuses no steps and one step over the most", async () => {
      for (const count of [0, PASSPORT_STEPS_MAX + 1]) {
        expect(
          await passportSteps(stampedDb(), undefined, "passport", fields(0), named(count)),
        ).toEqual({ kind: "invalid", field: "steps" });
      }
    });

    it("takes a step named in Arabic only or English only, and refuses one nameless step among named ones", async () => {
      expect(
        await passportSteps(stampedDb(), undefined, "passport", fields(2), [
          { name: { ar: "الأول" } },
          { name: { en: "Second" } },
        ]),
      ).toEqual({
        kind: "steps",
        steps: [
          { id: undefined, name: { ar: "الأول", en: null } },
          { id: undefined, name: { ar: null, en: "Second" } },
        ],
      });
      expect(
        await passportSteps(stampedDb(), undefined, "passport", fields(1), [
          { name: { en: "Named" } },
          { name: { ar: " ", en: "" } },
        ]),
      ).toEqual({ kind: "invalid", field: "steps" });
    });

    it("refuses an id on a new passport's step", async () => {
      expect(
        await passportSteps(stampedDb(), undefined, "passport", fields(1), [
          { id: ONE, name: { en: "A" } },
        ]),
      ).toEqual({ kind: "invalid", field: "steps" });
    });
  });

  describe("an edit", () => {
    it("leaves the steps alone when the edit names none", async () => {
      expect(await passportSteps(stampedDb(), stored(2), "passport", fields(2), undefined)).toEqual(
        { kind: "steps", steps: undefined },
      );
    });

    it("refuses one of its own steps named twice", async () => {
      expect(
        await passportSteps(stampedDb(), stored(1), "passport", fields(1), [
          { id: ONE, name: { en: "A" } },
          { id: ONE, name: { en: "B" } },
        ]),
      ).toEqual({ kind: "invalid", field: "steps" });
    });

    it("lowers needed while nobody stamped, and never once someone did", async () => {
      expect(await passportSteps(stampedDb(), stored(3), "passport", fields(1), undefined)).toEqual(
        { kind: "steps", steps: undefined },
      );
      expect(
        await passportSteps(stampedDb([ONE]), stored(3), "passport", fields(2), undefined),
      ).toEqual({ kind: "invalid", field: "needed" });
    });

    it("drops an unstamped step but keeps a stamped one", async () => {
      const keepOne = [
        { id: ONE, name: { en: "A" } },
        { id: THREE, name: { en: "C" } },
      ];
      expect(
        await passportSteps(stampedDb([ONE]), stored(1), "passport", fields(1), keepOne),
      ).toMatchObject({ kind: "steps" });
      expect(
        await passportSteps(stampedDb([TWO]), stored(1), "passport", fields(1), keepOne),
      ).toEqual({ kind: "step_in_use" });
    });
  });
});
