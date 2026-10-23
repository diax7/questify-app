# T-305c — Catch and tap rush: fixed-tick replay, reaction bounds, app screens

Delivers the last two of FR-1804's four games (F-87), on T-305's round machinery (ADR-212 to ADR-215). **Core bar**:
the two engines are the replay, and the replay is the only thing between a modified app and the ledger: one Opus plan
review, one Opus code review, mutation on GitHub. Migration **0051** (0050 is T-305's, undeployed and under its code
review; this task adds its own small file so either can change without the other). Depends on T-305 (`game_round`,
`start_game_round`, `finish_game_round`, `GameEngine`, `judge`, `judgeRound`, the registry, the app's `useRound`
gate and its retry).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-216 to ADR-218 and Q-181, Q-182.

## What stays exactly as T-305 built it

The protocol does not change: Play issues a seeded round (an attempt used at issue, idempotent by key, the engine
version frozen, `426 update_required` before an attempt for an app without the game's engine, which is how a T-305
build meets a catch quest: it sends no `catch` version, `0 < 1`); the app plays and sends `{inputs, claimed}`; the API
replays with the round's engine version and hands the verdict to `finish_game_round`, which checks the clock (`last
input > (now − issued_at) + 3 s` is `clock`), the window (time limit + 10 minutes) and pays once on the first pass.
Verdicts `passed`, `short`, `refused` (impossible: counts as played, `minigame` flag, the reason never sent to the
player) and `passed` + unlikely (paid and flagged). The refusal reasons are T-305's eight (`malformed`, `order`,
`too_fast`, `late`, `cap`, `illegal`, `claimed`, `clock`), so `game_round.reason`'s CHECK is untouched. The 64 KB body
limit holds (sizes below). Attempts, cooldown, the sweep, the switch, the lock on a played quest's config, erasure and
the rehearsal wipe already treat every game alike.

## Real-time replay (ADR-216)

Turn-based games replay exactly because an input is a discrete act. A real-time game has a world that moves between
inputs, and the phone draws it at whatever frame rate it manages. The rule that makes the replay exact: **the world
moves only on a fixed tick, in integers, and a frame never decides anything.**

- **The tick.** 30 ticks a second, from the moment the board shows (`t = 0`, T-305's monotonic clock). Every input
  still carries `t`, whole milliseconds (the shared `TimedInput`, so `lastInputMs` and the database's clock check work
  unchanged). One function maps time to ticks and one maps back, both integer-only and shared
  (`packages/shared/src/games/ticks.ts`):
  `tickAt(t) = Math.floor((t * 3) / 100)` and `tickStartMs(k) = Math.floor((k * 100 + 2) / 3)` (the first millisecond
  of tick `k`; `tickAt(tickStartMs(k)) === k`, tested for every tick of the longest round). Every value stays below
  2^31, so `Math.floor` of an integer division is exact in IEEE doubles on Node and on release Hermes alike.
- **The board.** A fixed field of 1,000 × 1,000 board units, layout-free and never mirrored (ADR-215). The app converts
  a finger to units **before** the gate (`Math.round(px * 1000 / width)`, clamped to 0..1,000); the integer it records
  is the only thing the replay sees, so screen size, density and rounding on the phone change nothing.
- **The engine.** A real-time engine is a T-305 `GameEngine` plus one function, `advance(state, tick) → state`: runs
  the world from `state.tick` to `tick` (never back; a lower tick returns the state as it was). `apply(state, input)` is
  `advance(state, tickAt(input.t))` and then the input's effect; `resultOf(state)` is the result of
  `advance(state, endTick)`. So `replay`, `judge`, `canInput` and `judgeRound` are reused **unchanged**: the replay is
  "advance to each input's tick, apply it, advance to the end". Integer arithmetic only, the shared PRNG, no
  `Math.random`, no floats in the world (`hermes-runtime.test.ts` covers the files).
- **Frames map to ticks, never the other way.** The app's loop (`apps/app/src/games/realtime.ts`, one pure
  `frame(loop, elapsedMs, finger) → loop` driven by `requestAnimationFrame`) reads the clock **once** per frame, then
  in this order: (1) records the frame's input through the gate, stamped with that `t`; (2) advances the state to
  `tickAt(t)`; (3) draws. Because the input is recorded before the world advances, an input's tick is never behind the
  state, so the app's live state after any frame is exactly the replay's state at that tick. A slow frame (200 ms) runs
  six ticks at once; a stalled app (background, a 2 s hitch) catches up on the next frame; neither changes a result,
  only how many inputs the player managed to make. Drawing may interpolate between tick `k` and `k + 1` with floats:
  display only, never fed back.
- **The round ends on a tick.** Each level has a fixed length (`timeLimitSeconds`, already what the deadline reads);
  `endTick = timeLimitSeconds * 30`. When `tickAt(t) >= endTick` the app stops recording, computes `claimed =
  resultOf(state)` and sends, with no "Done" button. An input after `timeLimitSeconds * 1000` ms is `late`.
- **Leaving the app does not pause the round** (the server's window does not pause): when the app comes back the loop
  catches up to the clock, items that landed meanwhile count as missed. The instruction card says so. A pause would
  need the server to see it, which it cannot.

**An honest player is never refused** (T-305's CTO 1, kept): every impossible rule below is one the app's gate applies
before recording, and the frame order above guarantees tick order. Property tests drive the **app's own `frame`
function**, not a re-implementation, with random frame gaps and random fingers (Tests).

## Catch

A basket slides along the bottom; items fall; catch enough of them.

- **The world from the seed.** An item list drawn once by `start(seed, params)`: the first spawns at tick 30 (1 s in),
  each next one `gapMin..gapMax` ticks later, each at an x in 50..950 and falling for `fallTicks` (so it lands at
  `spawnTick + fallTicks`). Every item is **reachable**: the next item's x is drawn within `basketSpeed × gap` of the
  previous one, so a perfect player can catch every item at every level (a test plays the seed perfectly). The worst
  case schedule lands before `endTick` (a test per level). Each item's picture is one of the default faces, by the seed.
- **The basket.** Starts at 500, aiming at 500. On each tick it moves toward its **target** by at most `basketSpeed`
  units (`basket += clamp(target − basket, −speed, speed)`), then every item landing on that tick is caught when
  `|basket − item.x| <= basketHalf`, else missed.
- **The input is the target, only when it changes** (T-305's CTO 9): `{t, x}`, x an integer 0..1,000. The player drags;
  the app records the finger's x at most once per tick and only when it differs from the last recorded target (a
  finger that does not move records nothing). Speed is capped by the world, so impossible movement cannot be
  expressed: a teleporting x is just a far target the basket walks to.
- **Impossible** (the gate drops each in the app; the replay refuses): two inputs on the same tick (`too_fast`; the
  app keeps the newest x pending and records it on the next tick), `t` below the previous input's (`order`), past the
  length (`late`), more than 1,800 inputs (`cap`, one per tick of the longest level), a malformed x (`malformed`, zod).
  `illegal` does not arise. A claimed result the replay does not reproduce is `claimed`, as for every game.
- **Result** `{caught, missed, foreseen}`. **Passes**: `caught >= catchTarget`.
- **Unlikely** (ADR-217): `foreseen >= unlikelyForesight`. A caught item is **foreseen** when the input that put the
  target over it was recorded before tick `spawnTick + 4` (133 ms after it appeared: under any human reaction) while
  the basket was more than `basketHalf` away from where it would land: the player started for a spot nothing on screen
  pointed at. An honest player sweeping about does this now and then; a player reading the seed does it all the time.
- **Size.** An input is at most `{"t":45000,"x":1000},` (22 bytes); 1,800 of them is 39.6 KB, under the 64 KB body
  limit with `claimed` and the JSON around it. The limit stays one number for every game.

## Tap rush

Targets pop up on a grid; tap each before it goes; a miss costs a point.

- **The world from the seed.** A 3 × 4 grid (12 cells, indexed row by row, never mirrored). Targets spawn from tick 15,
  each next one `gapMin..gapMax` ticks later, in a free cell drawn by the seed, and live `lifeTicks` ticks; spawning
  stops when a target could not live out its life before `endTick`. At most three are up at once at any level, so a
  free cell always exists (a test). Liveness is judged in milliseconds on the tick grid: a target is up for
  `tickStartMs(spawn) <= t < tickStartMs(spawn + lifeTicks)`.
- **The input is a tap on a cell**: `{t, cell}`, the cell the finger landed in (as memory's card index: no geometry in
  the replay). On a live target it is a **hit** (the target goes); on an empty cell, a **miss**.
- **Impossible** (the gate drops each; the replay refuses): two taps under T-305's 100 ms floor (`too_fast`; a
  two-finger tap inside 100 ms registers once, as a double flip does in memory), a hit on a target younger than
  **120 ms** (`too_fast`: measured from `tickStartMs(spawn)`, and the target reaches the screen only on the next frame,
  so a person's measured reaction is always longer than their real one), out of order, past the length, a cell off the
  grid (`illegal`), more than 300 taps (`cap`: 30 s at the floor).
- **Result** `{hits, misses, score, quick}`, `score = max(0, hits − misses)` (so tapping everywhere does not pass).
  **Passes**: `score >= scoreTarget`.
- **Unlikely** (ADR-217): `quick >= unlikelyQuick`, where `quick` counts hits 120 to 199 ms after the target appeared.
  Picking one of twelve cells and moving a finger there takes most people well over 250 ms; a run of hits under 200 ms
  is a bot or a seed reader.
- **Size**: 300 × `{"t":30000,"cell":11},` (23 bytes) is 6.9 KB.

**Changed from T-305's sketch** (its "Games in this task" paragraph): the 120 ms bound is a **gate, not a share**. T-305
proposed "more than a fifth of hits under 120 ms is impossible"; an honest fast tapper could cross a share by luck and
be refused, breaking the never-refuse rule. Dropping a too-early tap in the app costs an honest player nothing (they
tap again) and makes the replay's rule exact. The statistical signal moves to the unlikely flag, which never refuses.
Catch's input is `{t, x}` rather than `{tick, x}`, so the shared clock check reads it unchanged.

## Levels (ADR-218; numbers are tuning, Q-182)

`LEVELS` and the database's `game_level` gain six rows (sent with every round, so retuning is a deploy).

| Game | Level | Length | World | Pass target |
|---|---|---|---|---|
| Catch | easy | 45 s | 30 items, fall 2.0 s (60 ticks), gap 30–42 ticks, basket ±100, speed 40/tick | 20 caught |
| | medium | 45 s | 40 items, fall 1.6 s (48), gap 22–32, basket ±80, speed 40 | 30 caught |
| | hard | 45 s | 50 items, fall 1.2 s (36), gap 18–25, basket ±65, speed 45 | 40 caught |
| Tap rush | easy | 30 s | life 1.5 s (45 ticks), gap 18–24 | score 20 |
| | medium | 30 s | life 1.1 s (33), gap 14–19 | score 28 |
| | hard | 30 s | life 0.8 s (24), gap 11–15 | score 34 |

Params: catch `{timeLimitSeconds, items, fallTicks, gapMin, gapMax, basketHalf, basketSpeed, catchTarget,
unlikelyForesight}`, tap rush `{timeLimitSeconds, columns, rows, lifeTicks, gapMin, gapMax, scoreTarget,
unlikelyQuick}`. The two unlikely thresholds start at 6 (catch) and 8 (tap rush) and are **set by the property tests**,
as T-305 set `unlikelyLucky`: the honest model below is flagged in under 1% of 5,000 seeded rounds at each level, and
the seed-reading model in over 90%. If both cannot hold at a level, the threshold favours the honest player and the
build notes say so.

## Data (migration 0051; nothing new to deny)

- `quest_game_shape` dropped and re-added with `catch` and `tap_rush` in its game list (the rest of 0050's body
  unchanged); `game_round`'s game CHECK dropped and re-added with the four games.
- `game_level` made again (`CREATE OR REPLACE`, the same signature, `REVOKE ALL … FROM PUBLIC` restated) with the six
  rows above. No new table, function, grant or reason. The outsider and cross-tenant suites already list every game
  object; they run unchanged and must stay green.

## API

- The registry: `JUDGES` and `ENGINE_VERSIONS` gain `catch: {1}` and `tap_rush: {1}`; `GAME_NAMES` gains both;
  `gameTarget` gains `{game: "catch", caught, items}` and `{game: "tap_rush", score, seconds}`.
- `COMING_GAMES` is deleted with the builder's `not_available` branch and the dashboard's "Coming soon" entries (no
  game is left to come; replace, don't deprecate). The builder takes all four.
- No route, limit or body-limit change. A route test sends a full 1,800-input catch body and a passing round of each.

## App

- `apps/app/src/games/realtime.ts`: the `frame` function above and a `useRealtimeRound` hook (T-305's `useRound`
  with the loop; the same monotonic clock, `begin` when the board shows after the round arrived). `BOARDS` gains both
  engines.
- **Catch screen**: the field, items as a fixed pool of `Animated` views (positions set each frame from the
  interpolated tick state, no re-render per frame), the basket following a `PanResponder` drag (React Native's own: no
  gesture library, **no new native module and no new EAS build**), a countdown and a caught counter, a haptic on catch.
- **Tap rush screen**: twelve `Pressable` cells (`onPressIn`, so the tap time is the touch, not the release), a
  target art that pops in and shrinks out over its life, a countdown and score, a haptic on hit, a short shake on a
  miss. Accessible labels on cells ("Row 2, column 3, target"); the instruction card notes that both games need quick
  sight and touch, so an organizer can prefer the others for an accessible event (the builder's helper line too).
- The result, Retry, window and "Retry instead of Play" are T-305's, unchanged.
- **Art**: falling items and targets from the reviewed library (`docs/design/assets/currency`, `rewards`, `icons`), the
  basket from the reviewed set if one reads well at size, otherwise drawn from Views in the brand's wood and gold; each
  checked full size (the asset-review rule); no new generated art.
- Strings (Arabic via `ux-araby`, Western digits, RTL checked; drafts):

  | Key | English | Arabic |
  |---|---|---|
  | target.catch | Catch at least {target} of {items} items. | التقط {target} عنصرًا على الأقل من {items}. |
  | target.tapRush | Score {target} points in {seconds} seconds. A miss costs a point. | اجمع {target} نقطة خلال {seconds} ثانية. كل نقرة خاطئة تخصم نقطة. |
  | howTo.catch | Drag the basket to catch what falls. | اسحب السلة لتلتقط ما يسقط. |
  | howTo.tapRush | Tap each treasure before it disappears. | انقر كل كنز قبل أن يختفي. |
  | keepsRunning | The game keeps running if you leave the app. | تستمر اللعبة إذا غادرت التطبيق. |
  | short.catch | So close. You needed {target}; you caught {caught}. | اقتربت! المطلوب {target} والتقطت {caught}. |
  | short.tapRush | So close. You needed {target}; you scored {score}. | اقتربت! المطلوب {target} وجمعت {score}. |

## Dashboard

The builder's game choice lists all four with their targets in words; the preview line for each; the helper line on
the real-time pair. The flag page's `minigame` lines already show game, level, verdict and reason; the unlikely line
gains the count that tripped it (`foreseen 9`, `quick 11`) from the round's `result`.

## Tests (test first)

- **Ticks**: `tickAt(tickStartMs(k)) === k` and `tickAt(tickStartMs(k) − 1) === k − 1` for every tick to 1,800;
  monotonic; golden values.
- **Engines** (`catch/v1.test.ts`, `tap-rush/v1.test.ts`): three seeds' worlds fixed by snapshot; every item
  reachable and every schedule inside its length at every level over 5,000 seeds; a scripted perfect player passes
  every level; poor play is `short`; each impossible reason at its edge (same tick and next tick; 99 and 100 ms; 119
  and 120 ms on a fresh target; `t` at the length and one past; the caps and one over; cell 11 and 12); `claimed`
  differs; the unlikely counts at their edges (tick `spawn + 3` and `+ 4`; 199 and 200 ms); `advance` composes
  (`advance(advance(s, a), b)` equals `advance(s, b)`) and never goes back.
- **Property: honest play is never refused** (plain seeded loops, no new dependency), 500 seeds × 3 levels × 2 games,
  through the app's own `frame` and gate: frame gaps drawn from 8 to 250 ms with a 2 s stall in one round in ten; for
  catch a finger that wanders and chases the lowest visible item; for tap rush taps on random cells and on visible
  targets after a 230 to 730 ms reaction. Each round's recorded inputs, judged, are never `refused` and reproduce the
  app's `claimed` exactly. The same inputs replayed on a different frame schedule's state give the same result (frame
  timing changes nothing).
- **Property: the unlikely flags** (5,000 seeds per level): the honest models above flagged under 1%; a seed reader
  (catch: heads to the next landing as soon as the last item is caught; tap rush: taps each target 130 ms after it
  appears) flagged over 90% (Levels).
- **Database**: `game_level` equals `LEVELS` for all twelve rows; a catch and a tap rush quest save, issue (deadline =
  length + 10 minutes), pass and pay once; `quest_game_shape` refuses an unknown game.
- **Route**: the 1,800-input catch body is taken; a body of a passing `claimed` with failing inputs is refused; the
  builder takes `catch` and `tap_rush`.
- **App**: `frame` (input before advance, one input per tick, the pending x, the end), both boards from a seed, the
  instruction cards in Arabic, the result lines; `hermes-runtime.test.ts` over the new files; `expo export`. Web: the
  builder's four games, the flag line's count.
- **Mutation (GitHub)**: `packages/shared/src/games/ticks.ts`, `packages/shared/src/games/catch/**/*.ts`,
  `packages/shared/src/games/tap-rush/**/*.ts`, `packages/shared/src/games/registry.ts`,
  `packages/shared/src/games/levels.ts`.

## Phases (CTO code review once, at the end)

1. Shared: ticks, the two engines, levels, registry, with the engine and property tests (thresholds set here).
2. Migration 0051 + database tests + the security suites run.
3. API (registry use, builder, `COMING_GAMES` removed) + route tests.
4. App (`realtime.ts`, two screens, art, strings), dashboard (builder, flag line), docs (API.md game list, DATA_MODEL
   game names, SRS status of FR-1804, FEATURES, TASKS, STATE).

## Proposed decisions and questions

- **ADR-216** Real-time mini-game replay: the world moves only on a fixed 30 Hz tick, in integers, on a 1,000-unit
  board; inputs keep their time in whole milliseconds and one shared integer function maps them to ticks; a real-time
  engine adds `advance` to T-305's contract so the replay, judge and gate are reused unchanged; the app reads the clock
  once a frame, records the input before advancing, and draws by interpolation only, so frame rate and stalls never
  change a result; catch records the basket's target only when it changes, at most once a tick, and the basket's speed
  is capped by the world; the round runs on while the app is away. Q-181.
- **ADR-217** Reaction bounds in the real-time games: a tap on a target younger than 120 ms, or two taps inside 100 ms,
  is dropped by the app and impossible in a replay (a gate, so an honest player is never refused; replaces T-305's
  "more than a fifth of hits" sketch); fast-but-possible play is an unlikely flag (tap rush: hits under 200 ms; catch:
  catches started before the item could be seen) with level thresholds set so honest play is flagged in under 1% of
  seeded rounds. Q-181.
- **ADR-218** Catch and tap rush rules and levels: fixed lengths (45 s and 30 s), every catch item reachable by a
  perfect player, tap rush scored as hits minus misses, the table above as starting tuning; the 64 KB body limit stays
  one number for every game. Q-182.
- **Q-181** Agree to fixed-tick replay, the 120 ms tap gate, and flagging (never refusing) fast play? And that leaving
  the app does not pause a real-time round?
- **Q-182** The catch and tap rush numbers (lengths, speeds, targets, a miss costing a point in tap rush, the unlikely
  thresholds): keep as a start, to be tuned after a playtest from the rounds' stored counts?
