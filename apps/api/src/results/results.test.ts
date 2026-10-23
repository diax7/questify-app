import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Caller } from "#src/auth/sign-in";
import type { Actor } from "#src/events/events";
import {
  confirmResults,
  createPrize,
  listPrizes,
  memberRules,
  playerResults,
  readResults,
  refusalOf,
  removePrize,
  revealResults,
  rulesDataOf,
  updatePrize,
  updatePrizeSettings,
} from "#src/results/results";

const EVENT = "33333333-3333-4333-8333-333333333333";
const PRIZE = "66666666-6666-4666-8666-666666666666";
const PLAYER = "99999999-9999-4999-8999-999999999999";
const ACTOR = {
  staffUserId: "44444444-4444-4444-8444-444444444444",
  organizerId: "55555555-5555-4555-8555-555555555555",
} as unknown as Actor;
const CALLER = { requestId: "req-1", ip: "127.0.0.1" } as unknown as Caller;

type Answer = (sql: string, values: unknown[]) => Record<string, unknown>[] | Error;

/** A pool whose connection answers each call through `answer`, keeping each statement. */
function fakePool(answer: Answer) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      statements.push({ sql, values });
      const rows = answer(sql, values);
      if (rows instanceof Error) {
        throw rows;
      }
      return { rows };
    }),
    release: vi.fn(),
  };
  return { deps: { pool: { connect: async () => client } as unknown as Pool }, statements };
}

const pgError = (code: string | undefined, detail?: string) =>
  Object.assign(new Error("refused"), { code, detail });

const PRIZE_ROW = {
  id: PRIZE,
  rank_from: 1,
  rank_to: 3,
  kind: "item",
  name_ar: "كأس",
  name_en: "Cup",
  description_ar: null,
  description_en: "Gold",
};

/** Answers the event lock, the current prize and the writes for the prize editor. */
const editor =
  (status = "live", prize: Record<string, unknown> | null = PRIZE_ROW): Answer =>
  (sql) => {
    if (sql.includes("event_status_now")) {
      return [{ id: EVENT, timezone: "Asia/Riyadh", status_now: status }];
    }
    if (sql.includes("count(*)")) {
      return [{ n: 0 }];
    }
    if (sql.startsWith("SELECT id, rank_from")) {
      return prize === null ? [] : [prize];
    }
    if (sql.includes("RETURNING")) {
      return [{ ...PRIZE_ROW, rank_to: 2, description_en: "Silver" }];
    }
    return [];
  };

const audits = (statements: { sql: string; values: unknown[] }[]) =>
  statements.filter((s) => s.sql.includes("INSERT INTO audit_log")).map((s) => s.values);

describe("refusalOf", () => {
  it.each([
    ["AN404", "", { kind: "not_found" }],
    ["DL409", "", { kind: "desk_needed" }],
    ["22023", "", { kind: "invalid", field: "expected" }],
    ["RF409", "prizes_locked", { kind: "prizes_locked" }],
    ["RF409", "overlap", { kind: "overlap" }],
    ["RF409", "removed", { kind: "removed" }],
    ["RF409", "results_final", { kind: "results_final" }],
    ["RF409", "not_ended", { kind: "not_ended" }],
    ["RF409", "results_changed", { kind: "results_changed" }],
    ["RF409", "not_confirmed", { kind: "not_confirmed" }],
    ["RF409", "bad_deadline", { kind: "bad_deadline" }],
    ["RF409", "desk_closed_until_deadline", { kind: "desk_closed_until_deadline" }],
  ] as const)("answers %s %s as its refusal", (code, detail, expected) => {
    expect(refusalOf(code, detail)).toEqual(expected);
  });

  it("leaves anything else to be thrown", () => {
    expect(refusalOf("RF409", "other")).toBeUndefined();
    expect(refusalOf("XX000", "")).toBeUndefined();
    expect(refusalOf(undefined, "")).toBeUndefined();
  });

  it("throws what it does not know, and turns what it knows into a result", async () => {
    const boom = fakePool(() => pgError("XX000"));
    await expect(readResults(boom.deps, ACTOR, EVENT)).rejects.toThrow("refused");
    const plain = fakePool(() => new Error("down"));
    await expect(readResults(plain.deps, ACTOR, EVENT)).rejects.toThrow("down");
    const known = fakePool(() => pgError("AN404"));
    await expect(readResults(known.deps, ACTOR, EVENT)).resolves.toEqual({ kind: "not_found" });
  });
});

describe("the prize editor", () => {
  it("adds a prize with trimmed text and audits it", async () => {
    const { deps, statements } = fakePool(editor("draft"));
    const result = await createPrize(
      deps,
      ACTOR,
      EVENT,
      { kind: "item", rankFrom: 1, rankTo: 3, name: { en: " Cup ", ar: "" } },
      CALLER,
    );
    expect(result.kind).toBe("done");
    const insert = statements.find((s) => s.sql.startsWith("INSERT INTO rank_prize"));
    expect(insert?.values).toEqual([EVENT, "item", 1, 3, null, "Cup", null, null]);
    const [entry] = audits(statements);
    expect(entry).toEqual(
      expect.arrayContaining(["rank_prize.create", "rank_prize", PRIZE, "req-1"]),
    );
  });

  it("refuses ranks out of order, no name, too many prizes, a stranger's or an archived event", async () => {
    const plain = fakePool(editor("draft"));
    await expect(
      createPrize(
        plain.deps,
        ACTOR,
        EVENT,
        { kind: "item", rankFrom: 4, rankTo: 3, name: { en: "x" } },
        CALLER,
      ),
    ).resolves.toEqual({ kind: "invalid", field: "rankTo" });
    await expect(
      createPrize(plain.deps, ACTOR, EVENT, { kind: "item", rankFrom: 3, rankTo: 3 }, CALLER),
    ).resolves.toEqual({ kind: "invalid", field: "name" });
    const full = fakePool((sql, values) =>
      sql.includes("count(*)") ? [{ n: 100 }] : editor("draft")(sql, values),
    );
    await expect(
      createPrize(
        full.deps,
        ACTOR,
        EVENT,
        { kind: "item", rankFrom: 3, rankTo: 3, name: { en: "x" } },
        CALLER,
      ),
    ).resolves.toEqual({ kind: "limit_reached", limit: 100 });
    const stranger = fakePool(() => []);
    await expect(
      createPrize(
        stranger.deps,
        ACTOR,
        EVENT,
        { kind: "item", rankFrom: 3, rankTo: 3, name: { en: "x" } },
        CALLER,
      ),
    ).resolves.toEqual({ kind: "not_found" });
    const archived = fakePool(editor("archived"));
    await expect(
      removePrize(archived.deps, ACTOR, { eventId: EVENT, id: PRIZE }, CALLER),
    ).resolves.toEqual({
      kind: "event_archived",
    });
  });

  it("edits only what is sent and audits the change; unchanged edits write no audit", async () => {
    const { deps, statements } = fakePool(editor());
    const result = await updatePrize(
      deps,
      ACTOR,
      { eventId: EVENT, id: PRIZE },
      { rankTo: 2, description: { en: "Silver" } },
      CALLER,
    );
    expect(result).toMatchObject({
      kind: "done",
      value: { rankTo: 2, description: { en: "Silver" } },
    });
    const update = statements.find((s) => s.sql.startsWith("UPDATE rank_prize"));
    expect(update?.values).toEqual([EVENT, PRIZE, 1, 2, "كأس", "Cup", null, "Silver"]);
    const [entry] = audits(statements);
    expect(entry).toEqual(expect.arrayContaining(["rank_prize.update"]));
    expect(JSON.stringify(entry)).toContain("rankTo");

    const same = fakePool((sql, values) =>
      sql.includes("RETURNING") ? [PRIZE_ROW] : editor()(sql, values),
    );
    await updatePrize(same.deps, ACTOR, { eventId: EVENT, id: PRIZE }, {}, CALLER);
    expect(audits(same.statements)).toEqual([]);
  });

  it("answers not found for a prize that is gone, and removes one with an audit", async () => {
    const gone = fakePool(editor("live", null));
    await expect(
      updatePrize(gone.deps, ACTOR, { eventId: EVENT, id: PRIZE }, {}, CALLER),
    ).resolves.toEqual({
      kind: "not_found",
    });
    await expect(
      removePrize(gone.deps, ACTOR, { eventId: EVENT, id: PRIZE }, CALLER),
    ).resolves.toEqual({
      kind: "not_found",
    });
    const { deps, statements } = fakePool(editor("draft"));
    await expect(removePrize(deps, ACTOR, { eventId: EVENT, id: PRIZE }, CALLER)).resolves.toEqual({
      kind: "done",
      value: null,
    });
    expect(
      statements.some((s) => s.sql === "UPDATE rank_prize SET status = 'removed' WHERE id = $1"),
    ).toBe(true);
    expect(audits(statements)[0]).toEqual(expect.arrayContaining(["rank_prize.remove"]));
  });

  it("lists the switch, the rules and the prizes; a stranger gets not found", async () => {
    const { deps } = fakePool((sql) =>
      sql.startsWith("SELECT rank_prizes")
        ? [{ rank_prizes: false, rules_ar: "قواعد", rules_en: null }]
        : [PRIZE_ROW],
    );
    await expect(listPrizes(deps, ACTOR, EVENT)).resolves.toEqual({
      kind: "done",
      value: {
        rankPrizes: false,
        rules: { ar: "قواعد", en: null },
        prizes: [
          {
            id: PRIZE,
            rankFrom: 1,
            rankTo: 3,
            kind: "item",
            name: { ar: "كأس", en: "Cup" },
            description: { ar: null, en: "Gold" },
          },
        ],
      },
    });
    const stranger = fakePool(() => []);
    await expect(listPrizes(stranger.deps, ACTOR, EVENT)).resolves.toEqual({ kind: "not_found" });
  });

  it("writes the switch and the rules, keeping what is not sent, auditing each change on its own", async () => {
    const { deps, statements } = fakePool((sql, values) =>
      sql.startsWith("SELECT rank_prizes")
        ? [{ rank_prizes: true, rules_ar: "قديم", rules_en: "Old" }]
        : editor("draft")(sql, values),
    );
    const result = await updatePrizeSettings(
      deps,
      ACTOR,
      EVENT,
      { rules: { en: " New " } },
      CALLER,
    );
    expect(result).toEqual({
      kind: "done",
      value: { rankPrizes: true, rules: { ar: "قديم", en: "New" } },
    });
    expect(statements.find((s) => s.sql.startsWith("UPDATE event"))?.values).toEqual([
      EVENT,
      true,
      "قديم",
      "New",
    ]);
    expect(
      audits(statements).map((a) => a.find((v) => typeof v === "string" && v.startsWith("event."))),
    ).toEqual(["event.rules"]);
    const off = fakePool((sql, values) =>
      sql.startsWith("SELECT rank_prizes")
        ? [{ rank_prizes: true, rules_ar: null, rules_en: null }]
        : editor("draft")(sql, values),
    );
    await updatePrizeSettings(
      off.deps,
      ACTOR,
      EVENT,
      { rankPrizes: false, rules: { ar: "" } },
      CALLER,
    );
    expect(
      audits(off.statements).map((a) =>
        a.find((v) => typeof v === "string" && v.startsWith("event.")),
      ),
    ).toEqual(["event.rank_prizes"]);
    const archived = fakePool(editor("archived"));
    await expect(updatePrizeSettings(archived.deps, ACTOR, EVENT, {}, CALLER)).resolves.toEqual({
      kind: "event_archived",
    });
  });
});

const STATE = {
  state: "confirmed",
  rank_prizes: true,
  ends_at: new Date("2030-01-01T10:00:00Z"),
  confirmed_at: new Date("2030-01-01T11:00:00Z"),
  revealed_at: null,
  claim_until: null,
  default_claim_until: new Date("2030-01-04T10:00:00Z"),
};
const PLACE = {
  rank: 1,
  enrollment_id: "77777777-7777-4777-8777-777777777777",
  username: "sara",
  avatar: "fox",
  score: "300",
  open_flags: 1,
  flag_kinds: ["burst"],
  prize_id: PRIZE,
  prize_kind: "item",
  prize_name_ar: "كأس",
  prize_name_en: "Cup",
  redemption_status: "reserved",
};

const resultsAnswer: Answer = (sql) => {
  if (sql.includes("results_state")) {
    return [STATE];
  }
  if (sql.includes("results_places")) {
    return [
      PLACE,
      { ...PLACE, rank: 2, prize_id: null, flag_kinds: null, redemption_status: null },
    ];
  }
  if (sql.includes("confirm_results") || sql.includes("reveal_results")) {
    return [{ outcome: "confirmed" }];
  }
  return [];
};

describe("results", () => {
  it("reads the state and the places", async () => {
    const { deps } = fakePool(resultsAnswer);
    const result = await readResults(deps, ACTOR, EVENT);
    expect(result).toEqual({
      kind: "done",
      value: {
        state: "confirmed",
        rankPrizes: true,
        endsAt: "2030-01-01T10:00:00.000Z",
        confirmedAt: "2030-01-01T11:00:00.000Z",
        revealedAt: null,
        claimUntil: null,
        defaultClaimUntil: "2030-01-04T10:00:00.000Z",
        places: [
          {
            rank: 1,
            enrollmentId: PLACE.enrollment_id,
            player: { username: "sara", avatar: "fox" },
            score: 300,
            openFlags: 1,
            flagKinds: ["burst"],
            prize: { id: PRIZE, kind: "item", name: { ar: "كأس", en: "Cup" } },
            prizeStatus: "reserved",
          },
          expect.objectContaining({ rank: 2, prize: null, flagKinds: [], prizeStatus: null }),
        ],
      },
    });
  });

  it("confirms and reveals through the definers, answering the new view or owner_only", async () => {
    const { deps, statements } = fakePool(resultsAnswer);
    await expect(
      confirmResults(deps, ACTOR, { eventId: EVENT, expected: ["a"], requestId: "r1" }),
    ).resolves.toMatchObject({ kind: "done", value: { state: "confirmed" } });
    const claim = new Date("2030-01-03T10:00:00Z");
    await revealResults(deps, ACTOR, { eventId: EVENT, claimUntil: claim, requestId: "r2" });
    expect(statements.filter((s) => s.sql.includes("_results(")).map((s) => s.values)).toEqual([
      [EVENT, ["a"], "r1"],
      [EVENT, claim, "r2"],
    ]);
    const notOwner = fakePool(() => [{ outcome: "not_owner" }]);
    await expect(
      confirmResults(notOwner.deps, ACTOR, { eventId: EVENT, expected: [], requestId: "r" }),
    ).resolves.toEqual({ kind: "owner_only" });
    await expect(
      revealResults(notOwner.deps, ACTOR, { eventId: EVENT, claimUntil: claim, requestId: "r" }),
    ).resolves.toEqual({ kind: "owner_only" });
  });
});

describe("the player's results and rules", () => {
  const row = {
    rank: 1,
    username: "sara",
    avatar: "fox",
    score: "300",
    prize_kind: "item",
    prize_name_ar: "كأس",
    prize_name_en: "Cup",
    mine: true,
    redemption_id: "88888888-8888-4888-8888-888888888888",
    redemption_status: "reserved",
    claim_until: new Date("2030-01-03T10:00:00Z"),
  };

  it("names the caller's own prize, and nothing before the reveal", async () => {
    const { deps } = fakePool(() => [
      row,
      {
        ...row,
        rank: 2,
        mine: false,
        prize_kind: null,
        redemption_id: null,
        redemption_status: null,
      },
    ]);
    await expect(playerResults(deps, PLAYER, EVENT)).resolves.toEqual({
      revealed: true,
      places: [
        {
          rank: 1,
          player: { username: "sara", avatar: "fox" },
          score: 300,
          prize: { kind: "item", name: { ar: "كأس", en: "Cup" } },
          mine: true,
        },
        {
          rank: 2,
          player: { username: "sara", avatar: "fox" },
          score: 300,
          prize: null,
          mine: false,
        },
      ],
      me: {
        rank: 1,
        prize: { kind: "item", name: { ar: "كأس", en: "Cup" } },
        redemptionId: row.redemption_id,
        status: "reserved",
        claimUntil: "2030-01-03T10:00:00.000Z",
      },
    });
    const none = fakePool(() => []);
    await expect(playerResults(none.deps, PLAYER, EVENT)).resolves.toEqual({
      revealed: false,
      places: [],
      me: null,
    });
    const placedNoPrize = fakePool(() => [{ ...row, prize_kind: null, redemption_id: null }]);
    expect((await playerResults(placedNoPrize.deps, PLAYER, EVENT)).me).toBeNull();
  });

  const json = {
    rankPrizes: true,
    prizes: [{ rankFrom: 1, rankTo: 2, kind: "item", nameAr: null, nameEn: "Cup" }],
    organizer: "Najd Events",
    endsAt: "2030-01-01T10:00:00+00:00",
    timezone: "Asia/Riyadh",
    claimUntil: "2030-01-03T10:00:00+00:00",
    rulesAr: "اقرأ",
    rulesEn: null,
  };

  it("turns the database's rules data into the shared builder's", () => {
    expect(rulesDataOf(json)).toEqual({
      rankPrizes: true,
      prizes: [{ rankFrom: 1, rankTo: 2, name: { ar: null, en: "Cup" } }],
      organizer: "Najd Events",
      endsAt: new Date("2030-01-01T10:00:00Z"),
      timezone: "Asia/Riyadh",
      claimUntil: new Date("2030-01-03T10:00:00Z"),
      text: { ar: "اقرأ", en: null },
    });
    expect(
      rulesDataOf({ ...json, prizes: null, claimUntil: null, rankPrizes: false }),
    ).toMatchObject({
      rankPrizes: false,
      prizes: [],
      claimUntil: null,
    });
  });

  it("answers a member's rules, and undefined for anyone else", async () => {
    const member = fakePool(() => [{ rules: json }]);
    const rules = await memberRules(member.deps, PLAYER, EVENT);
    expect(rules?.block?.en).toContain("Ranks 1 to 2: Cup");
    expect(rules?.text).toEqual({ ar: "اقرأ", en: null });
    const stranger = fakePool(() => [{ rules: null }]);
    await expect(memberRules(stranger.deps, PLAYER, EVENT)).resolves.toBeUndefined();
    const nothing = fakePool(() => [{ rules: { ...json, prizes: [], rulesAr: null } }]);
    await expect(memberRules(nothing.deps, PLAYER, EVENT)).resolves.toBeNull();
  });
});
