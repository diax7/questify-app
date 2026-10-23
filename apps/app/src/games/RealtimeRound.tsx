import { formatNumber, type Theme } from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { comeBack, countLeft, leave, settle, startPause, type Pause } from "#src/games/realtime.ts";
import { monotonicNow } from "#src/games/round.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Cover = Readonly<{ kind: Pause["cover"]; count: number }>;

/**
 * A real-time round's clock and pause (ADR-216, CTO 1): the clock starts when the board shows; whenever the app leaves
 * the foreground the board is covered and the clock stops; on return the round ends at once if the result window is
 * too short for the rest of it (`onEnded`), else a 3-2-1 count runs, board still covered and clock still stopped.
 */
export function usePausableRound(
  round: Readonly<{ limitSeconds: number; deadlineAt: string; offsetMs: number }>,
  onEnded: () => void,
) {
  const pause = useRef<Pause>(startPause(monotonicNow()));
  const [cover, setCover] = useState<Cover>({ kind: "none", count: 0 });
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const { limitSeconds, deadlineAt, offsetMs } = round;

  const show = useCallback((now: number) => {
    setCover({ kind: pause.current.cover, count: countLeft(pause.current, now) });
  }, []);
  /** Settles the pause at `now` (the count may have run out) and answers it. */
  const read = useCallback((now: number): Pause => {
    pause.current = settle(pause.current, now);
    return pause.current;
  }, []);

  useEffect(() => {
    const watcher = AppState.addEventListener("change", (status) => {
      const now = monotonicNow();
      if (status !== "active") {
        pause.current = leave(pause.current, now);
      } else {
        const windowLeft = Date.parse(deadlineAt) - (Date.now() + offsetMs);
        pause.current = comeBack(pause.current, now, windowLeft, limitSeconds * 1000);
        if (pause.current.ended) {
          ended.current();
        }
      }
      show(now);
    });
    return () => watcher.remove();
  }, [deadlineAt, offsetMs, limitSeconds, show]);

  useEffect(() => {
    if (cover.kind !== "counting") {
      return undefined;
    }
    const ticking = setInterval(() => {
      const now = monotonicNow();
      read(now);
      show(now);
    }, 200);
    return () => clearInterval(ticking);
  }, [cover.kind, read, show]);

  return { read, cover };
}

/** The card over a paused board: "Paused", then the 3-2-1 count before play goes on. */
export function PauseCover({ cover }: Readonly<{ cover: Cover }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (cover.kind === "none") {
    return null;
  }
  return (
    <View style={styles.cover} accessibilityViewIsModal>
      <View style={styles.card}>
        <AppText accessibilityRole="alert">{t("play.game.paused")}</AppText>
        {cover.kind === "counting" ? (
          <AppText variant="display" accessibilityRole="timer">
            {formatNumber(cover.count, language)}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  cover: {
    position: "absolute" as const,
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: theme.colors.navigationBar,
    borderRadius: theme.radius.sm,
  },
  card: {
    alignItems: "center" as const,
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
  },
});
