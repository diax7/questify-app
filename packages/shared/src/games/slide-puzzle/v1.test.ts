import { describe, expect, it } from "vitest";
import { judge, replay } from "#src/games/engine";
import { GAME_LEVELS, LEVELS } from "#src/games/levels";
import { prng } from "#src/games/prng";
import {
  neighbours,
  SLIDE_MOVE_CAP,
  type SlideInput,
  type SlideParams,
  shuffled,
  slidePuzzleV1 as engine,
} from "#src/games/slide-puzzle/v1";
import { expectGateAgreesWithReplay } from "#src/games/testing/gate";

const easy = LEVELS.slide_puzzle.easy;

/** The taps that walk the shuffle back, `gap` ms apart: as many moves as the walk. */
function unwalk(seed: number, level: SlideParams, gap = 400): SlideInput[] {
  const { board, path } = shuffled(seed, level);
  const tiles = [...board];
  const inputs: SlideInput[] = [];
  for (let step = path.length - 1; step > 0; step -= 1) {
    const from = path[step - 1] as number;
    const into = path[step] as number;
    const tile = tiles[from] as number;
    inputs.push({ t: inputs.length * gap + gap, tile });
    tiles[into] = tile;
    tiles[from] = 0;
  }
  return inputs;
}

describe("slide puzzle: the board", () => {
  it("shuffles to a fixed, unsolved board with every tile once, the gap where the walk ended", () => {
    for (const level of GAME_LEVELS) {
      const params = LEVELS.slide_puzzle[level];
      for (const seed of [0, 1, -7, 123_456]) {
        const state = engine.start(seed, params);
        const cells = params.size * params.size;
        expect([...state.board].sort((a, b) => a - b)).toEqual(
          Array.from({ length: cells }, (_, index) => index),
        );
        expect(state.board[state.gap]).toBe(0);
        expect(state.solved).toBe(false);
        expect(shuffled(seed, params).path).toHaveLength(params.walk + 1);
      }
    }
    expect(engine.start(1, easy).board).toMatchInlineSnapshot(`
      [
        2,
        4,
        1,
        5,
        8,
        3,
        0,
        7,
        6,
      ]
    `);
    expect(engine.start(-9, easy).board).toMatchInlineSnapshot(`
      [
        1,
        8,
        2,
        5,
        3,
        7,
        4,
        6,
        0,
      ]
    `);
    expect(engine.start(77, LEVELS.slide_puzzle.hard).board).toMatchInlineSnapshot(`
      [
        6,
        5,
        14,
        10,
        8,
        4,
        1,
        11,
        15,
        9,
        0,
        12,
        13,
        3,
        2,
        7,
      ]
    `);
  });

  it("re-walks a shuffle that lands solved", () => {
    const short = { size: 3, walk: 2, timeLimitSeconds: 60 };
    for (let seed = 0; seed < 50; seed += 1) {
      expect(engine.start(seed, short).solved).toBe(false);
    }
  });

  it("never steps straight back during the walk", () => {
    const { path } = shuffled(5, LEVELS.slide_puzzle.medium);
    for (let step = 2; step < path.length; step += 1) {
      expect(path[step]).not.toBe(path[step - 2]);
      expect(neighbours(path[step - 1] as number, 3)).toContain(path[step]);
    }
  });

  it("picks one of the three pictures from the seed", () => {
    expect(engine.start(0, easy).picture).toBe(0);
    expect(engine.start(4, easy).picture).toBe(1);
    expect(engine.start(-1, easy).picture).toBe(0);
    expect(engine.start(-2, easy).picture).toBe(2);
  });

  it("knows each position's neighbours", () => {
    expect(neighbours(0, 3)).toEqual([3, 1]);
    expect(neighbours(4, 3)).toEqual([1, 7, 3, 5]);
    expect(neighbours(8, 3)).toEqual([5, 7]);
    expect(neighbours(15, 4)).toEqual([11, 14]);
  });
});

describe("slide puzzle: results", () => {
  it("solves every level by walking the shuffle back", () => {
    for (const level of GAME_LEVELS) {
      const params = LEVELS.slide_puzzle[level];
      const inputs = unwalk(11, params, 500);
      const played = replay(engine, 11, params, inputs);
      expect(played).toEqual({
        result: { solved: true, moves: params.walk, ms: params.walk * 500 },
      });
      if ("result" in played) {
        expect(engine.passes(played.result, params)).toBe(true);
        expect(engine.unlikely(played.result, params)).toBe(false);
      }
    }
  });

  it("falls short when time or taps run out unsolved", () => {
    const inputs = unwalk(11, easy).slice(0, 5);
    const played = replay(engine, 11, easy, inputs);
    expect(played).toEqual({ result: { solved: false, moves: 5, ms: 2000 } });
    expect(engine.passes({ solved: false, moves: 5, ms: 2000 }, easy)).toBe(false);
  });

  it("calls a solve unlikely only in fewer moves than the walk at under 300 ms a move", () => {
    const at = (moves: number, ms: number) => engine.unlikely({ solved: true, moves, ms }, easy);
    expect(at(19, 19 * 300 - 1)).toBe(true);
    expect(at(19, 19 * 300)).toBe(false);
    expect(at(20, 20 * 300 - 1)).toBe(false);
    expect(at(21, 100)).toBe(false);
    expect(engine.unlikely({ solved: false, moves: 5, ms: 600 }, easy)).toBe(false);
  });
});

describe("slide puzzle: impossible rounds", () => {
  const state = engine.start(2, easy);
  const movable = neighbours(state.gap, 3).map((position) => state.board[position] as number);
  const stuck = state.board.find(
    (tile, position) => tile > 0 && !neighbours(state.gap, 3).includes(position),
  ) as number;

  it("refuses a tile not next to the gap, the gap itself and a tile that is not there", () => {
    expect(replay(engine, 2, easy, [{ t: 0, tile: stuck }])).toEqual({ impossible: "illegal" });
    expect(replay(engine, 2, easy, [{ t: 0, tile: 0 }])).toEqual({ impossible: "illegal" });
    expect(replay(engine, 2, easy, [{ t: 0, tile: 9 }])).toEqual({ impossible: "illegal" });
    expect(replay(engine, 2, easy, [{ t: 0, tile: movable[0] as number }])).toHaveProperty(
      "result",
    );
  });

  it("refuses inputs out of order, too close or past the time limit", () => {
    const [first, second] = unwalk(2, easy);
    expect(
      replay(engine, 2, easy, [
        { ...first!, t: 500 },
        { ...second!, t: 499 },
      ]),
    ).toEqual({ impossible: "order" });
    expect(
      replay(engine, 2, easy, [
        { ...first!, t: 500 },
        { ...second!, t: 599 },
      ]),
    ).toEqual({ impossible: "too_fast" });
    expect(replay(engine, 2, easy, [{ ...first!, t: 180_001 }])).toEqual({ impossible: "late" });
  });

  it("refuses a tap after the puzzle is solved", () => {
    const inputs = unwalk(2, easy);
    const solved = replay(engine, 2, easy, inputs);
    expect(solved).toMatchObject({ result: { solved: true } });
    const last = inputs[inputs.length - 1] as SlideInput;
    expect(replay(engine, 2, easy, [...inputs, { t: last.t + 500, tile: last.tile }])).toEqual({
      impossible: "illegal",
    });
  });

  it("refuses a move over the cap", () => {
    const tile = movable[0] as number;
    const slow = { ...easy, timeLimitSeconds: 600 };
    const back = Array.from({ length: SLIDE_MOVE_CAP + 1 }, (_, index) => ({
      t: index * 500,
      tile,
    }));
    expect(replay(engine, 2, slow, back.slice(0, SLIDE_MOVE_CAP))).toHaveProperty("result");
    expect(replay(engine, 2, slow, back)).toEqual({ impossible: "cap" });
  });

  it("judges a claimed result the replay does not reproduce as refused", () => {
    const inputs = unwalk(2, easy).slice(0, 3);
    const round = { seed: 2, params: easy };
    expect(judge(engine, round, { inputs, claimed: { solved: true, moves: 3, ms: 1200 } })).toEqual(
      {
        verdict: "refused",
        reason: "claimed",
      },
    );
    expect(
      judge(engine, round, { inputs, claimed: { solved: false, moves: 3, ms: 1200 } }),
    ).toEqual({
      verdict: "short",
      result: { solved: false, moves: 3, ms: 1200 },
      unlikely: false,
    });
    expect(
      judge(engine, round, { inputs: [{ t: 0 }], claimed: { solved: false, moves: 0, ms: 0 } }),
    ).toEqual({
      verdict: "refused",
      reason: "malformed",
    });
  });
});

describe("slide puzzle: properties over a few seeds (the full run is in v1.calibration.test.ts)", () => {
  it("lets random taps through the app's gate into a legal round, the gate agreeing with the replay", () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const level = LEVELS.slide_puzzle[GAME_LEVELS[seed % 3] as "easy"];
      const random = prng(seed ^ 0x5bd1e995);
      expectGateAgreesWithReplay(engine, {
        seed,
        level,
        random,
        taps: 80,
        firstGap: 400,
        gap: 1500,
        inputAt: (t) => ({ t, tile: random.below(level.size * level.size + 1) }),
      });
    }
  });
});
