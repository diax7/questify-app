import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { HttpError } from "#src/http-error";
import {
  erasePlayer,
  exportPlayerData,
  readPendingHandovers,
} from "#src/console/players/data-request-doors";

const ADMIN = { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" };
const PLAYER = "6f1d2b3c-4a5e-4f60-8a71-92b3c4d5e6f7";
const EVENT = "8f0f8b8a-1d1b-4c55-9a77-0f6a6c9c1a11";
const CASE = { reasonCode: "legal_request", reference: "CR-1" } as const;
const ERASE = { ...CASE, playerId: PLAYER, username: "sara", forfeit: false };

/** A pool whose connection answers each statement by the first matching text; BEGIN and the context get no rows. */
function fakePool(answers: Readonly<Record<string, unknown[] | Error>>) {
  const query = vi.fn(async (sql: string) => {
    const match = Object.keys(answers).find((text) => sql.includes(text));
    const answer = match === undefined ? [] : answers[match];
    if (answer instanceof Error) throw answer;
    return { rows: answer ?? [] };
  });
  return { connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
}

const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("data request doors", () => {
  it("names the field a DR400 refusal is about", async () => {
    for (const [message, field] of [
      ["reference", "reference"],
      ["reason", "reasonCode"],
    ] as const) {
      const pool = fakePool({ console_player_export: refusal("DR400", message) });
      const failure = exportPlayerData(pool, ADMIN, { ...CASE, playerId: PLAYER }, "req-1");
      await expect(failure).rejects.toBeInstanceOf(HttpError);
      await expect(failure).rejects.toMatchObject({
        envelope: { code: "invalid_request", details: { field } },
      });
    }
  });

  it("asks for the typed name on DR409 and passes any other failure through", async () => {
    const typed = fakePool({ admin_erase_player: refusal("DR409", "name") });
    await expect(erasePlayer(typed, ADMIN, ERASE, "req-1")).rejects.toMatchObject({
      envelope: { code: "confirmation_required" },
    });
    const other = refusal("XX000", "internal");
    const broken = fakePool({ admin_erase_player: other });
    await expect(erasePlayer(broken, ADMIN, ERASE, "req-1")).rejects.toBe(other);
  });

  it("answers undefined when the export returns no row", async () => {
    const pool = fakePool({});
    expect(await exportPlayerData(pool, ADMIN, { ...CASE, playerId: PLAYER }, "r")).toBeUndefined();
  });

  it("reads the pending handovers in the console's shape", async () => {
    const pool = fakePool({
      "console_player_pending($1)": [
        {
          redemption_id: PLAYER,
          event_id: EVENT,
          event_ar: "حدث",
          event_en: null,
          item_ar: null,
          item_en: "Spa",
          rank_prize: true,
        },
      ],
    });
    expect(await readPendingHandovers(pool, ADMIN, PLAYER)).toEqual([
      {
        redemptionId: PLAYER,
        eventId: EVENT,
        event: { ar: "حدث", en: null },
        item: { ar: null, en: "Spa" },
        rankPrize: true,
      },
    ]);
  });

  it("answers no events when the erase returns none, and fails on a missing row", async () => {
    const none = fakePool({ admin_erase_player: [{ outcome: "already_deleted", events: null }] });
    expect(await erasePlayer(none, ADMIN, ERASE, "r")).toEqual({
      outcome: "already_deleted",
      events: [],
    });
    await expect(erasePlayer(fakePool({}), ADMIN, ERASE, "r")).rejects.toBeInstanceOf(ZodError);
  });
});
