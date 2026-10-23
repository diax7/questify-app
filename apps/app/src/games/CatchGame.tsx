import {
  catchV1,
  formatNumber,
  tickStartMs,
  type CatchParams,
  type CatchState,
  type Theme,
} from "@questify/shared";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Image, PanResponder, View, useWindowDimensions } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { PauseCover, usePausableRound } from "#src/games/RealtimeRound.tsx";
import {
  fallingItems,
  frame,
  gameTime,
  startCatch,
  toBoardUnits,
  type CatchLoop,
} from "#src/games/realtime.ts";
import { monotonicNow, secondsLeftOf, type Finished } from "#src/games/round.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The falling items' faces (ADR-218), from the reviewed currency art; the seed picks one of the 5 per item. */
const FACES = [
  require("#assets/currency/coin.png"),
  require("#assets/currency/crownCoin.png"),
  require("#assets/currency/gem.png"),
  require("#assets/currency/leaf.png"),
  require("#assets/currency/star.png"),
] as const;

/** At most this many items fall at once at any level: the views are a fixed pool, moved every frame. */
const POOL = 4;

const haptic = (run: () => Promise<void>) => void run().catch(() => undefined);

/** Where the world stands between tick k and k + 1, for drawing only (never fed back): 0 to 1. */
function between(t: number, tick: number): number {
  const start = tickStartMs(tick);
  return Math.min(1, Math.max(0, (t - start) / (tickStartMs(tick + 1) - start)));
}

/** The basket's x drawn this frame: part way to where the next tick puts it. */
function drawnBasket(state: CatchState, part: number): number {
  const speed = state.params.basketSpeed;
  return state.basket + Math.max(-speed, Math.min(speed, state.target - state.basket)) * part;
}

type Field = Readonly<{
  width: number;
  height: number;
  item: number;
  basket: number;
  basketHeight: number;
}>;

const fieldOf = (width: number, params: CatchParams): Field => ({
  width,
  height: Math.round(width * 1.25),
  item: Math.round(width * 0.1),
  basket: (params.basketHalf * 2 * width) / 1000,
  basketHeight: Math.round(width * 0.07),
});

/** What a frame shows beyond the moving views: the falling set, the catches and the seconds left. */
type Shown = Readonly<{ falling: readonly number[]; caught: number; left: number }>;

/** Draws a frame: the basket and the falling items move without a render; the counters render when they change. */
function useCatchDraw(params: CatchParams, field: Field) {
  const caughtSeen = useRef(0);
  const [shown, setShown] = useState<Shown>({
    falling: [],
    caught: 0,
    left: params.timeLimitSeconds,
  });
  const basketX = useRef(new Animated.Value((field.width - field.basket) / 2)).current;
  const pool = useRef(Array.from({ length: POOL }, () => new Animated.ValueXY())).current;
  const draw = useMemo(
    () => (state: CatchState, at: number) => {
      const part = between(at, state.tick);
      basketX.setValue((drawnBasket(state, part) * field.width) / 1000 - field.basket / 2);
      const falling = fallingItems(state).slice(0, POOL);
      falling.forEach((index, slot) => {
        const item = state.items[index];
        const fallen =
          item === undefined ? 0 : Math.min(1, (state.tick + part - item.spawn) / params.fallTicks);
        pool[slot]?.setValue({
          x: ((item?.x ?? 0) * field.width) / 1000 - field.item / 2,
          y: fallen * (field.height - field.basketHeight - field.item),
        });
      });
      const left = secondsLeftOf(params.timeLimitSeconds, at);
      if (state.caught > caughtSeen.current) {
        caughtSeen.current = state.caught;
        haptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
      }
      setShown((before) => {
        const same =
          before.falling.join() === falling.join() &&
          before.caught === state.caught &&
          before.left === left;
        return same ? before : { falling, caught: state.caught, left };
      });
    },
    [basketX, pool, field, params],
  );
  return { draw, shown, basketX, pool };
}

/** The finger on the field in board units, newest first; the frame loop takes it and clears it. */
function useFinger(fieldWidth: number) {
  const finger = useRef<number | null>(null);
  const fieldX = useRef(0);
  const responder = useMemo(() => {
    const follow = (pageX: number) => {
      finger.current = toBoardUnits(pageX - fieldX.current, fieldWidth);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => follow(event.nativeEvent.pageX),
      onPanResponderMove: (event) => follow(event.nativeEvent.pageX),
    });
  }, [fieldWidth]);
  return { finger, responder, fieldX };
}

/**
 * The frame loop (ADR-216): each frame reads the clock once, records the finger through the replay's gate, advances
 * the world, then moves the views; React renders only when what is shown changes.
 */
function useCatchFrames(
  loop: { current: CatchLoop },
  finger: { current: number | null },
  read: ReturnType<typeof usePausableRound>["read"],
  draw: (state: CatchState, at: number) => void,
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
        const seen = finger.current;
        finger.current = null;
        loop.current = frame(loop.current, at, seen);
        draw(loop.current.state, at);
        if (loop.current.ended) {
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
  }, [loop, finger, read, draw, end]);
}

/**
 * Catch on its server-issued round (T-305c, ADR-216): items fall from the seed on the fixed tick and the player drags
 * the basket. A fixed pool of views moves every frame. The field never mirrors. Ends on the last tick, or at once
 * when the app comes back with too little of the result window left.
 */
export function CatchGame({
  seed,
  params,
  deadlineAt,
  offsetMs,
  onFinish,
}: Readonly<{
  seed: number;
  params: CatchParams;
  deadlineAt: string;
  offsetMs: number;
  onFinish: (finished: Finished) => void;
}>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const loop = useRef(startCatch(seed, params));
  const finished = useRef(false);
  const [end] = useState(() => () => {
    if (!finished.current) {
      finished.current = true;
      onFinish({ inputs: [...loop.current.inputs], claimed: catchV1.resultOf(loop.current.state) });
    }
  });
  const round = usePausableRound(
    { limitSeconds: params.timeLimitSeconds, deadlineAt, offsetMs },
    end,
  );
  const fieldWidth = Math.min(width - 48, 520);
  const field = useMemo(() => fieldOf(fieldWidth, params), [fieldWidth, params]);
  const { draw, shown, basketX, pool } = useCatchDraw(params, field);
  const { finger, responder, fieldX } = useFinger(field.width);
  const fieldView = useRef<View>(null);
  useCatchFrames(loop, finger, round.read, draw, end);
  const nudge = (by: number) => {
    finger.current = Math.max(0, Math.min(1000, loop.current.state.target + by));
  };

  return (
    <>
      <View style={styles.status}>
        <AppText variant="label" accessibilityRole="timer">
          {t("play.game.timeLeft", { seconds: formatNumber(shown.left, language) })}
        </AppText>
        <AppText variant="label">
          {t("play.game.caught", { caught: formatNumber(shown.caught, language) })}
        </AppText>
      </View>
      <View
        ref={fieldView}
        onLayout={() => fieldView.current?.measureInWindow((x) => void (fieldX.current = x))}
        style={[styles.field, { width: field.width, height: field.height }]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t("play.game.basket")}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) =>
          nudge(event.nativeEvent.actionName === "increment" ? 100 : -100)
        }
        {...responder.panHandlers}
      >
        {pool.map((position, slot) => {
          const index = shown.falling[slot];
          const face = index === undefined ? undefined : loop.current.state.items[index]?.face;
          return face === undefined ? null : (
            <Animated.View
              key={slot}
              pointerEvents="none"
              style={[styles.item, { transform: position.getTranslateTransform() }]}
            >
              <Image
                source={FACES[face] ?? FACES[0]}
                style={{ width: field.item, height: field.item }}
              />
            </Animated.View>
          );
        })}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.basket,
            {
              width: field.basket,
              height: field.basketHeight,
              transform: [{ translateX: basketX }],
            },
          ]}
        />
        <PauseCover cover={round.cover} />
      </View>
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  status: { flexDirection: "row" as const, justifyContent: "space-between" as const },
  field: {
    direction: "ltr" as const,
    alignSelf: "center" as const,
    overflow: "hidden" as const,
    backgroundColor: theme.colors.surface,
    borderWidth: 2,
    borderColor: theme.colors.navigationBar,
    borderRadius: theme.radius.sm,
  },
  item: { position: "absolute" as const, top: 0, left: 0 },
  basket: {
    position: "absolute" as const,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.navigationBar,
    borderWidth: 3,
    borderColor: theme.colors.navigationActive,
    borderTopLeftRadius: theme.radius.sm,
    borderTopRightRadius: theme.radius.sm,
    borderBottomLeftRadius: theme.radius.md,
    borderBottomRightRadius: theme.radius.md,
  },
});
