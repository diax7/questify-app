import {
  MISMATCH_MS,
  formatNumber,
  memoryMatchV1,
  type MemoryParams,
  type MessageKey,
  type Theme,
} from "@questify/shared";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Animated, Image, Pressable, View, useWindowDimensions } from "react-native";
import { useReduceMotion } from "#src/components/motion.tsx";
import { GameStatus, useTimeLeft } from "#src/games/GameStatus.tsx";
import { faceUp, useRound, type Finished } from "#src/games/round.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The default card pictures (ADR-215), one per pair; organizer images are T-305b. */
const CARDS = [
  { art: require("#assets/games/cards/coffee.png"), name: "games.picture.coffee" },
  { art: require("#assets/games/cards/cap.png"), name: "games.picture.cap" },
  { art: require("#assets/games/cards/gift.png"), name: "games.picture.gift" },
  { art: require("#assets/games/cards/tote.png"), name: "games.picture.tote" },
  { art: require("#assets/games/cards/gem.png"), name: "games.picture.gem" },
  { art: require("#assets/games/cards/compass.png"), name: "games.picture.compass" },
  { art: require("#assets/games/cards/crown.png"), name: "games.picture.crown" },
  { art: require("#assets/games/cards/key.png"), name: "games.picture.key" },
  { art: require("#assets/games/cards/chest.png"), name: "games.picture.chest" },
  { art: require("#assets/games/cards/hourglass.png"), name: "games.picture.hourglass" },
] as const satisfies readonly { art: number; name: MessageKey }[];

const haptic = (run: () => Promise<void>) => void run().catch(() => undefined);

/** One card: it turns (a scale through its edge, on the native driver) when it changes side; still without motion. */
function Card({
  index,
  picture,
  up,
  columns,
  size,
  onFlip,
}: Readonly<{
  index: number;
  picture: number;
  up: boolean;
  columns: number;
  size: number;
  onFlip: (card: number) => void;
}>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const reduce = useReduceMotion();
  const turn = useRef(new Animated.Value(up ? 1 : 0)).current;
  const [face, setFace] = useState(up);
  useEffect(() => {
    if (reduce !== false) {
      turn.setValue(up ? 1 : 0);
      setFace(up);
      return;
    }
    Animated.timing(turn, { toValue: up ? 1 : 0, duration: 220, useNativeDriver: true }).start();
    const swap = setTimeout(() => setFace(up), 110);
    return () => clearTimeout(swap);
  }, [up, reduce, turn]);
  const scaleX = turn.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0, 1] });
  const card = CARDS[picture % CARDS.length] ?? CARDS[0];
  const label = t("play.game.card", {
    n: index + 1,
    row: Math.trunc(index / columns) + 1,
    column: (index % columns) + 1,
    state: up ? t("play.game.faceUp", { picture: t(card.name) }) : t("play.game.faceDown"),
  });
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => onFlip(index)}>
      <Animated.View
        style={[
          styles.card,
          { width: size, height: size },
          face ? styles.face : styles.back,
          { transform: [{ scaleX }] },
        ]}
      >
        {face ? (
          <Image source={card.art} style={{ width: size * 0.8, height: size * 0.8 }} />
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

/**
 * Memory match on its server-issued round (T-305): the board from the seed, laid out left to right in both languages
 * (ADR-215), every flip through the replay's own gate; a mismatch shows both cards for 700 ms, during which the gate
 * takes no flip. Ends when every pair is found or the time runs out.
 */
export function MemoryGame({
  seed,
  params,
  onFinish,
}: Readonly<{ seed: number; params: MemoryParams; onFinish: (finished: Finished) => void }>) {
  const { language } = useI18n();
  const { width } = useWindowDimensions();
  const round = useRound(memoryMatchV1, seed, params);
  const [mismatch, setMismatch] = useState<readonly number[] | null>(null);
  const ended = useRef(false);
  const end = () => {
    if (!ended.current) {
      ended.current = true;
      onFinish({
        inputs: [...round.inputs.current],
        claimed: memoryMatchV1.resultOf(round.current.current),
      });
    }
  };
  const left = useTimeLeft(params.timeLimitSeconds, round.elapsed, end);
  useEffect(() => round.begin(), [round.begin]);

  const flip = (card: number) => {
    const before = round.current.current;
    if (ended.current || !round.tap((t) => ({ t, card }))) {
      return;
    }
    const after = round.current.current;
    if (before.open === null) {
      return;
    }
    if (after.found > before.found) {
      haptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
    } else {
      setMismatch([before.open, card]);
      setTimeout(() => setMismatch(null), MISMATCH_MS);
    }
    if (after.found === params.pairs) {
      end();
    }
  };

  const size = Math.floor(Math.min(width - 48, 520) / params.columns) - 8;
  return (
    <>
      <GameStatus secondsLeft={left} moves={formatNumber(round.state.moves, language)} />
      <View
        style={{
          direction: "ltr",
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "center",
        }}
      >
        {round.state.deck.map((picture, index) => (
          <Card
            key={index}
            index={index}
            picture={picture}
            up={faceUp(round.state, index, mismatch)}
            columns={params.columns}
            size={size}
            onFlip={flip}
          />
        ))}
      </View>
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    borderRadius: theme.radius.md,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 2,
    borderColor: theme.colors.navigationBar,
  },
  back: { backgroundColor: theme.colors.navigationBar },
  face: { backgroundColor: theme.colors.surface },
});
