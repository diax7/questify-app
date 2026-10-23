import { formatNumber } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { secondsLeftOf } from "#src/games/round.ts";
import { useI18n } from "#src/i18n/provider.tsx";

/** The seconds left on the round's clock, read four times a second; `onTimeUp` runs once when they reach 0. */
export function useTimeLeft(
  limitSeconds: number,
  elapsed: () => number,
  onTimeUp: () => void,
): number {
  const [left, setLeft] = useState(limitSeconds);
  const timeUp = useRef(onTimeUp);
  timeUp.current = onTimeUp;
  useEffect(() => {
    const ticking = setInterval(() => {
      const now = secondsLeftOf(limitSeconds, elapsed());
      setLeft(now);
      if (now === 0) {
        clearInterval(ticking);
        timeUp.current();
      }
    }, 250);
    return () => clearInterval(ticking);
  }, [limitSeconds, elapsed]);
  return left;
}

/** The round's clock and move count above the board, in Western digits. */
export function GameStatus({
  secondsLeft,
  moves,
}: Readonly<{ secondsLeft: number; moves: string }>) {
  const { t, language } = useI18n();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <AppText variant="label" accessibilityRole="timer">
        {t("play.game.timeLeft", { seconds: formatNumber(secondsLeft, language) })}
      </AppText>
      <AppText variant="label">{t("play.game.moves", { moves })}</AppText>
    </View>
  );
}
