import { EMPTY_EQUIPMENT } from "@questify/shared";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { HttpError } from "#src/http-error";
import { readQuestifyRanking } from "#src/questify/ranking";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const shown = {
  rank: 120,
  username: "sara_k",
  avatar: "falcon",
  equipment: EMPTY_EQUIPMENT,
  xp: 300,
  level: 2,
};
const top = { ...shown, rank: 1, username: "khalid_m", xp: 900, isMe: false };

async function clientAnswering(answer: (sql: string, values: readonly unknown[]) => FakeAnswer) {
  const seen: { sql: string; values: readonly unknown[] }[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    return answer(sql, values);
  });
  return { client: (await pool.connect()) as PoolClient, seen };
}

describe("readQuestifyRanking (T-408)", () => {
  it("asks the door for the scope and answers the lifetime board with no month", async () => {
    const { client, seen } = await clientAnswering(() => ({
      rows: [{ r: { board: "all", rows: [top], me: shown } }],
    }));
    expect(await readQuestifyRanking(client, "lifetime")).toEqual({
      scope: "lifetime",
      month: null,
      rows: [top],
      me: shown,
    });
    expect(seen).toEqual([{ sql: "SELECT questify_ranking($1) AS r", values: ["lifetime"] }]);
  });

  it("names the month of a month board, and answers no place for a caller without XP", async () => {
    const { client } = await clientAnswering(() => ({
      rows: [{ r: { board: "2026-10", rows: [], me: null } }],
    }));
    expect(await readQuestifyRanking(client, "month")).toEqual({
      scope: "month",
      month: "2026-10",
      rows: [],
      me: null,
    });
  });

  it.each([
    ["PI401", 401, "unauthenticated"],
    ["QW404", 404, "ranking_off"],
  ])("answers %s as %i %s", async (code, status, name) => {
    const { client } = await clientAnswering(() => {
      throw pgError({ code });
    });
    const answer = await readQuestifyRanking(client, "lifetime").catch((error: unknown) => error);
    expect(answer).toBeInstanceOf(HttpError);
    expect(answer).toMatchObject({ status, envelope: { code: name } });
  });

  it("rethrows any other database error, and fails on a missing answer", async () => {
    const other = await clientAnswering(() => {
      throw pgError({ code: "22023" });
    });
    await expect(readQuestifyRanking(other.client, "lifetime")).rejects.toMatchObject({
      code: "22023",
    });
    const empty = await clientAnswering(() => ({ rows: [] }));
    await expect(readQuestifyRanking(empty.client, "lifetime")).rejects.toThrow(/no result/);
  });

  it("refuses an answer carrying a key the door must never send", async () => {
    const { client } = await clientAnswering(() => ({
      rows: [{ r: { board: "all", rows: [], me: { ...shown, playerId: "x" } } }],
    }));
    await expect(readQuestifyRanking(client, "lifetime")).rejects.toThrow();
  });
});
