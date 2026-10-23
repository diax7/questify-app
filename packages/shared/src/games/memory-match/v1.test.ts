import { describe, expect, it } from "vitest";
import { canInput, judge, replay } from "#src/games/engine";
import { GAME_LEVELS, LEVELS } from "#src/games/levels";
import {
  MEMORY_FLIP_CAP,
  type MemoryInput,
  type MemoryParams,
  type MemoryState,
  MISMATCH_MS,
  memoryMatchV1 as engine,
} from "#src/games/memory-match/v1";
import { prng } from "#src/games/prng";

const easy = LEVELS.memory_match.easy;
const medium = LEVELS.memory_match.medium;

/** The two cards of each picture, in picture order. */
function pairsOf(state: MemoryState): [number, number][] {
  const pairs: [number, number][] = [];
  state.deck.forEach((picture, card) => {
    const pair = pairs[picture];
    if (pair === undefined) {
      pairs[picture] = [card, -1];
    } else {
      pair[1] = card;
    }
  });
  return pairs;
}

/** A player who sees the layout and flips each pair in turn, `gap` ms apart. */
function seeingPlayer(seed: number, level: MemoryParams, gap = 150): MemoryInput[] {
  const inputs: MemoryInput[] = [];
  for (const [first, second] of pairsOf(engine.start(seed, level))) {
    inputs.push({ t: (inputs.length + 1) * gap, card: first });
    inputs.push({ t: (inputs.length + 1) * gap, card: second });
  }
  return inputs;
}

/** Plays `choose` through the app's own gate until the round ends; returns the recorded inputs and last state. */
function play(
  seed: number,
  level: MemoryParams,
  choose: (state: MemoryState, t: number) => MemoryInput | undefined,
): { inputs: MemoryInput[]; state: MemoryState } {
  let state = engine.start(seed, level);
  const inputs: MemoryInput[] = [];
  let t = 0;
  while (state.found < level.pairs && inputs.length < MEMORY_FLIP_CAP) {
    t = Math.max(t + 150, state.pauseUntil);
    const input = choose(state, t);
    if (input === undefined || t > level.timeLimitSeconds * 1000) {
      break;
    }
    if (canInput(engine, state, input)) {
      state = engine.apply(state, input);
      inputs.push(input);
    }
  }
  return { inputs, state };
}

/** A player who never forgets a card and never peeks: flips unseen cards in a random order. */
function rememberingPlayer(seed: number, level: MemoryParams, luck: number) {
  const random = prng(luck);
  return play(seed, level, (state, t) => {
    const faceDown = (card: number) => state.matched[card] === false && card !== state.open;
    const known = (picture: number, besides: number) =>
      state.deck.findIndex(
        (other, card) => other === picture && card !== besides && state.seen[card] === true,
      );
    if (state.open !== null) {
      const partner = known(state.deck[state.open] as number, state.open);
      if (partner >= 0) {
        return { t, card: partner };
      }
    } else {
      const knownPair = state.deck.findIndex(
        (picture, card) => faceDown(card) && state.seen[card] === true && known(picture, card) >= 0,
      );
      if (knownPair >= 0) {
        return { t, card: knownPair };
      }
    }
    const unseen = state.deck
      .map((_, card) => card)
      .filter((card) => faceDown(card) && state.seen[card] === false);
    return { t, card: unseen[random.below(unseen.length)] as number };
  });
}

describe("memory match: the board", () => {
  it("lays every picture out twice, in a seed's fixed order", () => {
    for (const level of GAME_LEVELS) {
      const params = LEVELS.memory_match[level];
      const deck = engine.start(77, params).deck;
      expect(deck).toHaveLength(params.pairs * 2);
      expect(params.columns * params.rows).toBe(params.pairs * 2);
      for (let picture = 0; picture < params.pairs; picture += 1) {
        expect(deck.filter((card) => card === picture)).toHaveLength(2);
      }
    }
    expect(engine.start(1, easy).deck).toMatchInlineSnapshot(`
      [
        0,
        4,
        1,
        3,
        2,
        0,
        2,
        1,
        4,
        5,
        5,
        3,
      ]
    `);
    expect(engine.start(-5, easy).deck).toMatchInlineSnapshot(`
      [
        1,
        0,
        0,
        2,
        1,
        3,
        2,
        5,
        5,
        4,
        4,
        3,
      ]
    `);
    expect(engine.start(2_000_000_000, medium).deck).toMatchInlineSnapshot(`
      [
        6,
        0,
        3,
        7,
        3,
        7,
        2,
        0,
        4,
        5,
        4,
        5,
        1,
        6,
        1,
        2,
      ]
    `);
  });
});

describe("memory match: results", () => {
  it("passes every level with a perfect game", () => {
    for (const level of GAME_LEVELS) {
      const params = LEVELS.memory_match[level];
      const played = replay(engine, 31, params, seeingPlayer(31, params));
      expect(played).toEqual({
        result: {
          pairs: params.pairs,
          moves: params.pairs,
          ms: params.pairs * 300,
          lucky: expect.any(Number),
        },
      });
      if ("result" in played) {
        expect(engine.passes(played.result, params)).toBe(true);
      }
    }
  });

  it("falls short with too many moves on a level that counts them, and passes the same play on easy", () => {
    const result = { pairs: 8, moves: 21, ms: 50_000, lucky: 0 };
    expect(engine.passes(result, medium)).toBe(false);
    expect(engine.passes({ ...result, moves: 20 }, medium)).toBe(true);
    expect(engine.passes({ ...result, pairs: 6 }, easy)).toBe(true);
    expect(engine.passes({ ...result, pairs: 5 }, easy)).toBe(false);
    expect(engine.passes({ ...result, pairs: 7, moves: 10 }, medium)).toBe(false);
  });

  it("counts a move per two flips and keeps the last flip's time", () => {
    const state = engine.start(1, easy);
    const [first, second] = pairsOf(state)[0] as [number, number];
    const other = pairsOf(state)[1]?.[0] as number;
    const played = replay(engine, 1, easy, [
      { t: 0, card: first },
      { t: 400, card: other },
      { t: 1200, card: second },
      { t: 1400, card: first },
    ]);
    expect(played).toEqual({ result: { pairs: 1, moves: 2, ms: 1400, lucky: 0 } });
  });

  it("calls the level's count of lucky matches unlikely and one fewer not", () => {
    expect(engine.unlikely({ pairs: 6, moves: 6, ms: 9000, lucky: 3 }, easy)).toBe(true);
    expect(engine.unlikely({ pairs: 6, moves: 6, ms: 9000, lucky: 2 }, easy)).toBe(false);
    expect(engine.unlikely({ pairs: 8, moves: 8, ms: 9000, lucky: 4 }, medium)).toBe(true);
    expect(engine.unlikely({ pairs: 8, moves: 8, ms: 9000, lucky: 3 }, medium)).toBe(false);
  });

  it("counts a lucky match only on a never-seen second card while 4 or more cards were unseen", () => {
    const state = engine.start(3, easy);
    const pairs = pairsOf(state);
    const flips = pairs.flatMap(([first, second]) => [first, second]);
    const played = replay(
      engine,
      3,
      easy,
      flips.map((card, index) => ({ t: (index + 1) * 200, card })),
    );
    // Unseen before each second flip: 11, 9, 7, 5, 3, 1; lucky while 4 or more.
    expect(played).toMatchObject({ result: { lucky: 4 } });
    const seenFirst = replay(engine, 3, easy, [
      { t: 0, card: pairs[0]?.[1] as number },
      { t: 200, card: pairs[1]?.[0] as number },
      { t: 1000, card: pairs[0]?.[0] as number },
      { t: 1200, card: pairs[0]?.[1] as number },
    ]);
    expect(seenFirst).toMatchObject({ result: { pairs: 1, lucky: 0 } });
  });
});

describe("memory match: impossible rounds", () => {
  const state = engine.start(1, easy);
  const [first, second] = pairsOf(state)[0] as [number, number];
  const [third] = pairsOf(state)[1] as [number, number];
  const reason = (inputs: MemoryInput[]) => replay(engine, 1, easy, inputs);

  it("refuses a card that is not there, a matched card and the face-up card", () => {
    expect(reason([{ t: 0, card: 12 }])).toEqual({ impossible: "illegal" });
    expect(
      reason([
        { t: 0, card: first },
        { t: 200, card: second },
        { t: 400, card: first },
      ]),
    ).toEqual({ impossible: "illegal" });
    expect(
      reason([
        { t: 0, card: first },
        { t: 200, card: first },
      ]),
    ).toEqual({ impossible: "illegal" });
  });

  it("refuses a flip during the mismatch pause and takes one right after it", () => {
    const mismatch = [
      { t: 0, card: first },
      { t: 200, card: third },
    ];
    expect(reason([...mismatch, { t: 200 + MISMATCH_MS - 1, card: second }])).toEqual({
      impossible: "illegal",
    });
    expect(reason([...mismatch, { t: 200 + MISMATCH_MS, card: second }])).toHaveProperty("result");
  });

  it("refuses inputs out of order, closer than 100 ms, or past the time limit", () => {
    expect(
      reason([
        { t: 500, card: first },
        { t: 400, card: third },
      ]),
    ).toEqual({ impossible: "order" });
    expect(
      reason([
        { t: 500, card: first },
        { t: 599, card: third },
      ]),
    ).toEqual({ impossible: "too_fast" });
    expect(
      reason([
        { t: 500, card: first },
        { t: 600, card: third },
      ]),
    ).toHaveProperty("result");
    expect(reason([{ t: easy.timeLimitSeconds * 1000 + 1, card: first }])).toEqual({
      impossible: "late",
    });
    expect(reason([{ t: easy.timeLimitSeconds * 1000, card: first }])).toHaveProperty("result");
  });

  it("refuses a flip after every pair was found", () => {
    const inputs = seeingPlayer(1, easy);
    expect(replay(engine, 1, easy, [...inputs, { t: 99_000, card: first }])).toEqual({
      impossible: "illegal",
    });
  });

  it("refuses a flip over the cap", () => {
    const flips: MemoryInput[] = [];
    for (let index = 0; index <= MEMORY_FLIP_CAP; index += 1) {
      flips.push({ t: index * 100, card: index % 2 === 0 ? first : third });
    }
    const slow = { ...easy, timeLimitSeconds: 600 };
    const pauseFree = flips.map((input, index) => ({ ...input, t: index * 1000 }));
    expect(replay(engine, 1, slow, pauseFree.slice(0, MEMORY_FLIP_CAP))).toHaveProperty("result");
    expect(replay(engine, 1, slow, pauseFree)).toEqual({ impossible: "cap" });
  });
});

describe("memory match: the server's judgement", () => {
  const round = { seed: 8, params: medium };

  it("passes a perfect game and flags it as unlikely", () => {
    const inputs = seeingPlayer(8, medium);
    const claimed = replay(engine, 8, medium, inputs);
    expect(
      judge(engine, round, { inputs, claimed: "result" in claimed ? claimed.result : null }),
    ).toEqual({
      verdict: "passed",
      result: { pairs: 8, moves: 8, ms: 2400, lucky: expect.any(Number) },
      unlikely: true,
    });
  });

  it("never trusts a claimed result the replay does not reproduce", () => {
    const inputs = seeingPlayer(8, medium).slice(0, 4);
    expect(
      judge(engine, round, { inputs, claimed: { pairs: 8, moves: 8, ms: 600, lucky: 0 } }),
    ).toEqual({
      verdict: "refused",
      reason: "claimed",
    });
    expect(
      judge(engine, round, { inputs, claimed: { pairs: 2, moves: 2, ms: 600, lucky: 2 } }),
    ).toEqual({
      verdict: "short",
      result: { pairs: 2, moves: 2, ms: 600, lucky: 2 },
      unlikely: false,
    });
  });

  it("refuses malformed inputs and a malformed claim", () => {
    const claimed = { pairs: 0, moves: 0, ms: 0, lucky: 0 };
    for (const inputs of [
      null,
      "x",
      [{ t: -1, card: 0 }],
      [{ t: 1.5, card: 0 }],
      [{ t: 0, card: 0, x: 1 }],
    ]) {
      expect(judge(engine, round, { inputs, claimed })).toEqual({
        verdict: "refused",
        reason: "malformed",
      });
    }
    expect(judge(engine, round, { inputs: [], claimed: { pairs: 0 } })).toEqual({
      verdict: "refused",
      reason: "malformed",
    });
    const tooMany = Array.from({ length: MEMORY_FLIP_CAP * 2 + 1 }, (_, t) => ({ t, card: 0 }));
    expect(judge(engine, round, { inputs: tooMany, claimed })).toEqual({
      verdict: "refused",
      reason: "malformed",
    });
    expect(judge(engine, round, { inputs: [], claimed })).toEqual({
      verdict: "short",
      result: claimed,
      unlikely: false,
    });
  });
});

describe("memory match: properties over many seeds", () => {
  it("replays the app's own recorded inputs to its claimed result, and an honest app is never impossible", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const level = LEVELS.memory_match[GAME_LEVELS[seed % 3] as "easy"];
      const { inputs, state } = rememberingPlayer(seed * 7919 - 1_000_000, level, seed);
      expect(replay(engine, seed * 7919 - 1_000_000, level, inputs)).toEqual({
        result: engine.resultOf(state),
      });
    }
  });

  it("passes random taps through the app's gate into a legal round, and the gate agrees with the replay", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const level = LEVELS.memory_match[GAME_LEVELS[seed % 3] as "easy"];
      const random = prng(seed + 1);
      let state = engine.start(seed, level);
      const inputs: MemoryInput[] = [];
      let t = random.below(300);
      for (let tap = 0; tap < 300; tap += 1) {
        const input = { t, card: random.below(level.pairs * 2 + 2) };
        const allowed = canInput(engine, state, input);
        expect(replay(engine, seed, level, [...inputs, input]), `seed ${seed}`).toEqual(
          allowed
            ? { result: engine.resultOf(engine.apply(state, input)) }
            : expect.objectContaining({ impossible: expect.any(String) }),
        );
        if (allowed) {
          state = engine.apply(state, input);
          inputs.push(input);
        }
        t += random.below(900);
      }
      expect(replay(engine, seed, level, inputs)).toEqual({ result: engine.resultOf(state) });
    }
  });

  it("flags fewer than 1% of rounds of a player who remembers every card but never peeks", () => {
    for (const level of GAME_LEVELS) {
      const params = LEVELS.memory_match[level];
      let flagged = 0;
      for (let seed = 0; seed < 5000; seed += 1) {
        const { state } = rememberingPlayer(seed, params, seed + 99_991);
        flagged += engine.unlikely(engine.resultOf(state), params) ? 1 : 0;
      }
      expect(flagged / 5000, level).toBeLessThan(0.01);
    }
  });
});
