import {
  formatNumber,
  tapRushV1,
  tickAt,
  tickStartMs,
  type TapRushParams,
  type TapRushState,
  type Theme,
} from "@questify/shared";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Animated, Image, Pressable, View, useWindowDimensions } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useReduceMotion } from "#src/components/motion.tsx";
import { PauseCover, usePausableRound } from "#src/games/RealtimeRound.tsx";
import { gameTime, liveTargets } from "#src/games/realtime.ts";
import { gateTap, monotonicNow, secondsLeftOf, type Finished } from "#src/games/round.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

const TREASURE = require("#assets/games/cards/chest.png");

const haptic = (run: () => Promise<void>) => void run().catch(() => undefined);

/** The size a target keeps when the phone asks for less motion. */
const STILL = new Animated.Value(1);
const NO_SHAKE = new Animated.Value(0);

/** What the board shows: the live target in each cell (or -1), the score and the seconds left. */
type Shown = Readonly<{ cells: readonly number[]; score: number; left: number }>;

/** One cell: the treasure pops in and shrinks over its life; a miss shakes the cell. Still without motion. */
function Cell({
  index,
  columns,
  size,
  target,
  grow,
  shake,
  onTap,
}: Readonly<{
  index: number;
  columns: number;
  size: number;
  target: boolean;
  grow: Animated.Value;
  shake: Animated.Value;
  onTap: (cell: number) => void;
}>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const place = { row: Math.trunc(index / columns) + 1, column: (index % columns) + 1 };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(target ? "play.game.cellTarget" : "play.game.cell", place)}
      onPressIn={() => onTap(index)}
    >
      <Animated.View
        style={[styles.cell, { width: size, height: size, transform: [{ translateX: shake }] }]}
      >
        {target ? (
          <Animated.View style={{ transform: [{ scale: grow }] }}>
            <Image source={TREASURE} style={{ width: size * 0.8, height: size * 0.8 }} />
          </Animated.View>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

/** The scale a target is drawn at: popping in over its first 120 ms, then shrinking to half by the end of its life. */
function growOf(state: TapRushState, index: number, at: number): number {
  const target = state.targets[index];
  if (target === undefined) {
    return 0;
  }
  const born = tickStartMs(target.spawn);
  const life = tickStartMs(target.spawn + state.params.lifeTicks) - born;
  const age = at - born;
  return age < 120 ? Math.max(0.2, age / 120) : 1 - (0.5 * (age - 120)) / Math.max(1, life - 120);
}

/** The frame loop: draws only (the targets, their size, the counters); taps never wait for a frame. */
function useTapRushFrames(
  state: { current: TapRushState },
  read: ReturnType<typeof usePausableRound>["read"],
  grows: readonly Animated.Value[],
  show: (shown: Shown) => void,
  end: () => void,
) {
  useEffect(() => {
    let request = 0;
    let running = true;
    const step = () => {
      const now = monotonicNow();
      const pause = read(now);
      if (pause.cover === "none" && !pause.ended) {
        const at = gameTime(pause.clock, now);
        const cells = Array.from({ length: grows.length }, () => -1);
        for (const index of liveTargets(state.current, tickAt(at))) {
          const cell = state.current.targets[index]?.cell ?? 0;
          cells[cell] = index;
          grows[cell]?.setValue(growOf(state.current, index, at));
        }
        const { score } = tapRushV1.resultOf(state.current);
        show({ cells, score, left: secondsLeftOf(state.current.params.timeLimitSeconds, at) });
        if (at >= state.current.params.timeLimitSeconds * 1000) {
          end();
          running = false;
        }
      }
      if (running) {
        request = requestAnimationFrame(step);
      }
    };
    request = requestAnimationFrame(step);
    return () => {
      running = false;
      cancelAnimationFrame(request);
    };
  }, [state, read, grows, show, end]);
}

/**
 * A tap, stamped at the touch on the paused-aware game clock (CTO 4) and put through the replay's own gate; a hit
 * buzzes, a miss shakes its cell. Nothing is taken while the board is covered or after the end.
 */
function useTap(
  state: { current: TapRushState },
  inputs: { current: { t: number; cell: number }[] },
  finished: { current: boolean },
  read: ReturnType<typeof usePausableRound>["read"],
  shakes: readonly Animated.Value[],
  motion: boolean,
) {
  return (cell: number) => {
    const now = monotonicNow();
    const pause = read(now);
    if (finished.current || pause.cover !== "none" || pause.ended) {
      return;
    }
    const before = state.current;
    const input = { t: gameTime(pause.clock, now), cell };
    const gated = gateTap(tapRushV1, before, input);
    if (!gated.accepted) {
      return;
    }
    state.current = gated.state;
    inputs.current.push(input);
    const shake = shakes[cell];
    if (gated.state.hits > before.hits) {
      haptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
    } else if (gated.state.misses > before.misses && motion && shake !== undefined) {
      Animated.sequence(
        [6, -6, 4, 0].map((toValue) =>
          Animated.timing(shake, { toValue, duration: 40, useNativeDriver: true }),
        ),
      ).start();
    }
  };
}

/**
 * Tap rush on its server-issued round (T-305c, ADR-217): targets pop up on a 3 × 4 grid from the seed; each tap is
 * stamped at the touch on the paused-aware game clock and goes through the replay's own gate (a tap on a target under
 * 120 ms old, or under 100 ms after the last tap, is dropped). The grid never mirrors. Ends when the time is up.
 */
export function TapRushGame({
  seed,
  params,
  deadlineAt,
  offsetMs,
  onFinish,
}: Readonly<{
  seed: number;
  params: TapRushParams;
  deadlineAt: string;
  offsetMs: number;
  onFinish: (finished: Finished) => void;
}>) {
  const { t, language } = useI18n();
  const { width } = useWindowDimensions();
  const reduce = useReduceMotion();
  const cells = params.columns * params.rows;
  const state = useRef(tapRushV1.start(seed, params));
  const inputs = useRef<{ t: number; cell: number }[]>([]);
  const finished = useRef(false);
  const grows = useRef(Array.from({ length: cells }, () => new Animated.Value(1))).current;
  const shakes = useRef(Array.from({ length: cells }, () => new Animated.Value(0))).current;
  const [shown, setShown] = useState<Shown>({ cells: [], score: 0, left: params.timeLimitSeconds });
  const [end] = useState(() => () => {
    if (!finished.current) {
      finished.current = true;
      onFinish({ inputs: [...inputs.current], claimed: tapRushV1.resultOf(state.current) });
    }
  });
  const round = usePausableRound(
    { limitSeconds: params.timeLimitSeconds, deadlineAt, offsetMs },
    end,
  );
  const [show] = useState(() => (next: Shown) => {
    setShown((before) =>
      before.cells.join() === next.cells.join() &&
      before.score === next.score &&
      before.left === next.left
        ? before
        : next,
    );
  });
  useTapRushFrames(state, round.read, grows, show, end);

  const tap = useTap(state, inputs, finished, round.read, shakes, reduce === false);

  const size = Math.floor(Math.min(width - 48, 420) / params.columns) - 8;
  return (
    <>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <AppText variant="label" accessibilityRole="timer">
          {t("play.game.timeLeft", { seconds: formatNumber(shown.left, language) })}
        </AppText>
        <AppText variant="label">
          {t("play.game.score", { score: formatNumber(shown.score, language) })}
        </AppText>
      </View>
      <View
        style={{
          direction: "ltr",
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "center",
          alignSelf: "center",
          width: (size + 8) * params.columns,
        }}
      >
        {grows.map((grow, index) => (
          <Cell
            key={index}
            index={index}
            columns={params.columns}
            size={size}
            target={(shown.cells[index] ?? -1) >= 0}
            grow={reduce === false ? grow : STILL}
            shake={shakes[index] ?? NO_SHAKE}
            onTap={tap}
          />
        ))}
        <PauseCover cover={round.cover} />
      </View>
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  cell: {
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.navigationBar,
    backgroundColor: theme.colors.surface,
  },
});
