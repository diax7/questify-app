import { formatNumber, slidePuzzleV1, type SlideParams, type Theme } from "@questify/shared";
import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";
import { Animated, Image, Pressable, View, useWindowDimensions } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useReduceMotion } from "#src/components/motion.tsx";
import { GameStatus, useTimeLeft } from "#src/games/GameStatus.tsx";
import { useRound, type Finished } from "#src/games/round.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The default puzzle pictures (ADR-215), chosen by the seed; organizer pictures are T-305b. */
const PICTURES = [
  require("#assets/games/puzzles/picture-0.jpg"),
  require("#assets/games/puzzles/picture-1.jpg"),
  require("#assets/games/puzzles/picture-2.jpg"),
] as const;

const haptic = (run: () => Promise<void>) => void run().catch(() => undefined);

/** Where a tile sits now: its row and column on the board. */
const placeOf = (board: readonly number[], tile: number, size: number) => {
  const position = board.indexOf(tile);
  return { row: Math.trunc(position / size), column: position % size };
};

/**
 * One tile: its part of the picture (cut from where the tile belongs) and its number, sliding to where it sits now
 * with a transform on the native driver; it jumps without motion.
 */
function Tile({
  tile,
  board,
  size,
  cell,
  picture,
  onSlide,
}: Readonly<{
  tile: number;
  board: readonly number[];
  size: number;
  cell: number;
  picture: number;
  onSlide: (tile: number) => void;
}>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const reduce = useReduceMotion();
  const now = placeOf(board, tile, size);
  const offset = useRef(new Animated.ValueXY({ x: now.column * cell, y: now.row * cell })).current;
  useEffect(() => {
    const to = { x: now.column * cell, y: now.row * cell };
    if (reduce !== false) {
      offset.setValue(to);
      return;
    }
    Animated.timing(offset, { toValue: to, duration: 120, useNativeDriver: true }).start();
  }, [now.column, now.row, cell, reduce, offset]);
  const home = { row: Math.trunc((tile - 1) / size), column: (tile - 1) % size };
  return (
    <Animated.View
      style={[
        styles.tile,
        { width: cell, height: cell, transform: offset.getTranslateTransform() },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("play.game.tile", {
          n: tile,
          row: now.row + 1,
          column: now.column + 1,
        })}
        onPress={() => onSlide(tile)}
        style={styles.press}
      >
        <Image
          source={PICTURES[picture] ?? PICTURES[0]}
          style={{
            position: "absolute",
            width: cell * size,
            height: cell * size,
            left: -home.column * cell,
            top: -home.row * cell,
          }}
        />
        <View style={styles.badge}>
          <AppText variant="label">{formatNumber(tile, language)}</AppText>
        </View>
      </Pressable>
    </Animated.View>
  );
}

/**
 * The slide puzzle on its server-issued round (T-305): the shuffle from the seed, one tile per tap, every tap through
 * the replay's own gate (only a tile next to the gap moves). The board never mirrors (ADR-215). Ends when the picture
 * is whole or the time runs out.
 */
export function SlideGame({
  seed,
  params,
  onFinish,
}: Readonly<{ seed: number; params: SlideParams; onFinish: (finished: Finished) => void }>) {
  const { language } = useI18n();
  const { width } = useWindowDimensions();
  const styles = useThemedStyles(makeStyles);
  const round = useRound(slidePuzzleV1, seed, params);
  const ended = useRef(false);
  const end = () => {
    if (!ended.current) {
      ended.current = true;
      onFinish({
        inputs: [...round.inputs.current],
        claimed: slidePuzzleV1.resultOf(round.current.current),
      });
    }
  };
  const left = useTimeLeft(params.timeLimitSeconds, round.elapsed, end);
  useEffect(() => round.begin(), [round.begin]);

  const slide = (tile: number) => {
    if (ended.current || !round.tap((t) => ({ t, tile }))) {
      return;
    }
    haptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
    if (round.current.current.solved) {
      haptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
      end();
    }
  };

  const cell = Math.floor(Math.min(width - 48, 480) / params.size);
  const tiles = round.state.board.filter((tile) => tile > 0).sort((a, b) => a - b);
  return (
    <>
      <GameStatus secondsLeft={left} moves={formatNumber(round.state.moves, language)} />
      <View style={[styles.board, { width: cell * params.size, height: cell * params.size }]}>
        {tiles.map((tile) => (
          <Tile
            key={tile}
            tile={tile}
            board={round.state.board}
            size={params.size}
            cell={cell}
            picture={round.state.picture}
            onSlide={slide}
          />
        ))}
      </View>
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  board: {
    direction: "ltr" as const,
    alignSelf: "center" as const,
    backgroundColor: theme.colors.navigationBar,
    borderRadius: theme.radius.sm,
  },
  tile: {
    position: "absolute" as const,
    overflow: "hidden" as const,
    borderWidth: 1,
    borderColor: theme.colors.navigationBar,
  },
  press: { flex: 1 },
  badge: {
    position: "absolute" as const,
    top: 2,
    left: 2,
    paddingHorizontal: 4,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surface,
  },
});
