import { canInput } from "#src/games/engine";
import {
  MEMORY_FLIP_CAP,
  type MemoryInput,
  type MemoryParams,
  type MemoryState,
  memoryMatchV1 as engine,
} from "#src/games/memory-match/v1";
import { prng } from "#src/games/prng";

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

/** A player who never forgets a card and never peeks (tests only): flips unseen cards in a random order. */
export function rememberingPlayer(seed: number, level: MemoryParams, luck: number) {
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
