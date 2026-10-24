import { formatNumber, type Theme } from "@questify/shared";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import {
  MEASURE_KEYS,
  fillOf,
  lineOf,
  markerOf,
  rewardText,
  type CommunityCard,
} from "#src/event/community.ts";
import { clockText } from "#src/event/polls.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The phone's clock, each second while the goal runs, so the time left counts down. */
function useSecondClock(running: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * The community goal on the event's Home (T-306b, FR-250): a wooden bar filling with gold from the start of the reading
 * direction (right in Arabic), a marker per milestone, "{progress} of {target}", the time left, then "Counting the last
 * points…" until it is settled, and "Reached!" or "Not reached". The bar is a progress bar with its value read out.
 */
export function CommunityBar({ card }: Readonly<{ card: CommunityCard }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const now = useSecondClock(card.status === "running");
  const line = lineOf(card, now);
  const progress = formatNumber(card.progress, language);
  const target = formatNumber(card.target, language);
  const fill = fillOf(card);
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <AppText variant="label" muted>
        {t("community.title")}
      </AppText>
      <AppText variant="title">{textIn(card.title, language)}</AppText>
      <AppText muted>{t(MEASURE_KEYS[card.measure])}</AppText>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("community.bar")}
        accessibilityValue={{
          min: 0,
          max: card.target,
          now: Math.min(card.progress, card.target),
          text: t("community.progress", { progress, target }),
        }}
        style={styles.track}
      >
        <View style={[styles.fill, { width: `${fill * 100}%` }]} />
        {card.steps
          .filter((step) => !step.isGoal)
          .map((step) => (
            <View
              key={step.threshold}
              style={[
                styles.marker,
                { start: `${markerOf(step, card.target) * 100}%` },
                step.reachedAt === null ? null : styles.markerReached,
              ]}
            />
          ))}
      </View>
      <AppText variant="label">{t("community.progress", { progress, target })}</AppText>
      <AppText variant="label">
        {line.kind === "ends_in"
          ? t("community.endsIn", { time: clockText(line.seconds) })
          : t(
              line.kind === "counting"
                ? "community.counting"
                : line.kind === "reached"
                  ? "community.reached"
                  : "community.notReached",
            )}
      </AppText>
      {card.steps.map((step) => {
        const reward = rewardText(step, card.paidTo === "everyone", t, language);
        return reward === null ? null : (
          <AppText key={step.threshold} muted={step.reachedAt === null}>
            {t("community.step", { threshold: formatNumber(step.threshold, language), reward })}
            {step.reachedAt === null ? "" : " ✓"}
          </AppText>
        );
      })}
      {card.contributed ? <AppText variant="label">{t("community.contributed")}</AppText> : null}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  // Wood with a gold fill (brand deck); it fills from the start of the reading direction (RTL layout flips it).
  track: {
    height: 18,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.navigationBar,
    overflow: "hidden" as const,
    flexDirection: "row" as const,
  },
  fill: { height: 18, backgroundColor: theme.colors.navigationActive },
  marker: {
    position: "absolute" as const,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: theme.colors.border,
  },
  markerReached: { backgroundColor: theme.colors.highlight },
});
