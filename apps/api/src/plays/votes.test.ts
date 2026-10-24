import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readPoll, readVote, resultsShown, voteCounts } from "#src/plays/votes";

type Answer = (sql: string) => Record<string, unknown>[] | Error;

/** A pool whose connection answers each statement through `answer`. */
function fakePool(answer: Answer) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      const rows = answer(sql);
      if (rows instanceof Error) {
        throw rows;
      }
      return { rows };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool };
}

const pgError = (code: string) => Object.assign(new Error("database refusal"), { code });
const PLAYER = "11111111-1111-4111-8111-111111111111";
const QUEST = "22222222-2222-4222-8222-222222222222";
const CONTEXT = {
  organizerId: "33333333-3333-4333-8333-333333333333",
  staffUserId: "44444444-4444-4444-8444-444444444444",
};
const OPTION = { option_id: "o1", text_ar: "نعم", text_en: "Yes" };
const POLL = {
  title_ar: "ما رأيك؟",
  title_en: "What do you think?",
  points: 5,
  choices: "one",
  results: "after_vote",
  closes_at: new Date("2030-01-01T10:05:00Z"),
  closed: false,
  mine: [] as string[],
  server_now: new Date("2030-01-01T10:00:00Z"),
};

describe("resultsShown", () => {
  it("shows the counts after the player's vote, at the close, or never, by the poll's policy", () => {
    expect(resultsShown({ results: "after_vote", closed: false, mine: ["o1"] })).toBe(true);
    expect(resultsShown({ results: "after_vote", closed: true, mine: [] })).toBe(false);
    expect(resultsShown({ results: "at_close", closed: true, mine: [] })).toBe(true);
    expect(resultsShown({ results: "at_close", closed: false, mine: ["o1"] })).toBe(false);
    expect(resultsShown({ results: "never", closed: true, mine: ["o1"] })).toBe(false);
  });
});

describe("readVote", () => {
  it("answers the database's refusal", async () => {
    expect(
      await readVote(
        fakePool(() => pgError("QC403")),
        PLAYER,
        QUEST,
      ),
    ).toEqual({
      kind: "enrollment_inactive",
      reason: "",
    });
  });
});

describe("voteCounts", () => {
  it("counts no voters when nobody voted", async () => {
    expect(
      await voteCounts(
        fakePool(() => []),
        CONTEXT,
        { eventId: CONTEXT.organizerId, questId: QUEST },
      ),
    ).toEqual({ kind: "done", value: { options: [], total: 0, voters: 0 } });
  });
});

/** The poll, its options, and no counts. */
const answer =
  (poll: Record<string, unknown>): Answer =>
  (sql) => {
    if (sql.includes("member_poll")) {
      return [poll];
    }
    if (sql.includes("member_vote")) {
      return [OPTION];
    }
    return [];
  };

describe("readPoll", () => {
  it("answers the poll with its title and window, holding the counts back until the player votes", async () => {
    expect(await readPoll(fakePool(answer(POLL)), PLAYER, QUEST)).toEqual({
      kind: "done",
      value: {
        title: { ar: "ما رأيك؟", en: "What do you think?" },
        points: 5,
        options: [{ id: "o1", text: { ar: "نعم", en: "Yes" } }],
        choices: "one",
        results: "after_vote",
        closesAt: "2030-01-01T10:05:00.000Z",
        closed: false,
        mine: [],
        counts: null,
        resultsWhen: "after_vote",
        serverNow: "2030-01-01T10:00:00.000Z",
      },
    });
  });

  it("shows no voters when the counts come back empty", async () => {
    const read = await readPoll(fakePool(answer({ ...POLL, mine: ["o1"] })), PLAYER, QUEST);
    expect(read).toMatchObject({
      kind: "done",
      value: { counts: { options: [], voters: 0 }, resultsWhen: null },
    });
  });

  it("answers the database's refusal", async () => {
    expect(
      await readPoll(
        fakePool(() => pgError("QC403")),
        PLAYER,
        QUEST,
      ),
    ).toEqual({
      kind: "enrollment_inactive",
      reason: "",
    });
  });
});
