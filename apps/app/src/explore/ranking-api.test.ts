import type { QuestifyRanking } from "@questify/shared";
import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { fetchQuestifyRanking, questifyRankingRows } from "#src/explore/ranking-api.ts";

const equipment = { character: null, frame: null, title: null };
const shown = (rank: number) => ({
  rank,
  username: `player${rank}`,
  avatar: "fox",
  equipment,
  xp: 1000 - rank,
  level: 3,
});
const top = (meAt?: number) =>
  Array.from({ length: 10 }, (_, index) => ({ ...shown(index + 1), isMe: index + 1 === meAt }));
const ranking = (rows: QuestifyRanking["rows"], me: QuestifyRanking["me"]): QuestifyRanking => ({
  scope: "lifetime",
  month: null,
  rows,
  me,
});

const sessionAnswering = (answer: AuthedResult) => ({ request: vi.fn().mockResolvedValue(answer) });
const ok = (body: unknown): AuthedResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});
const refused = (status: number, code: string): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details: {},
  headers: new Headers(),
});

describe("fetchQuestifyRanking", () => {
  it("asks for the scope and returns a ranking that fits the schema", async () => {
    const body = ranking(top(), null);
    const session = sessionAnswering(ok(body));
    await expect(fetchQuestifyRanking(session, "lifetime")).resolves.toEqual({
      kind: "ranking",
      ranking: body,
    });
    await fetchQuestifyRanking(session, "month");
    expect(session.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/v1/questify/ranking?scope=lifetime",
    });
    expect(session.request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/v1/questify/ranking?scope=month",
    });
  });

  it("answers off only for the switched-off ranking", async () => {
    await expect(
      fetchQuestifyRanking(sessionAnswering(refused(404, "ranking_off")), "lifetime"),
    ).resolves.toEqual({ kind: "off" });
    await expect(
      fetchQuestifyRanking(sessionAnswering(refused(404, "not_found")), "lifetime"),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("answers failed for a network error, a server error and a body of another shape", async () => {
    for (const answer of [
      { kind: "network" } as const,
      refused(500, "internal"),
      ok({ scope: "lifetime", rows: "nope" }),
      ok({ ...ranking(top(), null), rows: [{ ...top()[0], gems: 5 }] }),
    ]) {
      await expect(fetchQuestifyRanking(sessionAnswering(answer), "lifetime")).resolves.toEqual({
        kind: "failed",
      });
    }
  });

  it("passes a sign-out on", async () => {
    await expect(
      fetchQuestifyRanking(sessionAnswering({ kind: "signed_out" }), "month"),
    ).resolves.toEqual({ kind: "signed_out" });
  });
});

describe("questifyRankingRows", () => {
  it("shows the top rows only when the player is among them", () => {
    const rows = questifyRankingRows(ranking(top(4), shown(4)));
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.isMe).map((row) => row.rank)).toEqual([4]);
  });

  it("adds the player's own row as an 11th with their real rank", () => {
    const rows = questifyRankingRows(ranking(top(), shown(37)));
    expect(rows).toHaveLength(11);
    expect(rows[10]).toMatchObject({ rank: 37, username: "player37", isMe: true });
  });

  it("adds nothing for a player without XP on the board, and shows an empty board as empty", () => {
    expect(questifyRankingRows(ranking(top(), null))).toHaveLength(10);
    expect(questifyRankingRows(ranking([], null))).toEqual([]);
  });

  it("gives every row its own key", () => {
    const keys = questifyRankingRows(ranking(top(), shown(37))).map((row) => row.key);
    expect(new Set(keys).size).toBe(11);
  });
});
