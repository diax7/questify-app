import type { LevelRewards, Theme } from "@questify/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
import { ScrollView, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { api } from "#src/api/app-session.ts";
import { usePlayer, type Me } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { AchievementRewards } from "#src/questify/AchievementRewards.tsx";
import { LevelPlaque, NextRewardCard } from "#src/questify/JourneyHeader.tsx";
import { LevelTrail } from "#src/questify/LevelTrail.tsx";
import { ProfileGate } from "#src/questify/ProfileGate.tsx";
import { useQuestifySync } from "#src/questify/QuestifySyncProvider.tsx";
import { nextReward, stonesOf } from "#src/questify/journey.ts";
import { fetchLevelRewards } from "#src/questify/questify-api.ts";
import { useRead } from "#src/questify/use-read.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * Opens the trail at the player's own stone when it sits below the first screen: a high level should not start with
 * thirty stones to scroll past. Once only, so a reread after a sync never moves the page.
 */
function useScrollToCurrent() {
  const { height } = useWindowDimensions();
  const scroll = useRef<ScrollView>(null);
  const trailTop = useRef<number | null>(null);
  const stoneTop = useRef<number | null>(null);
  const done = useRef(false);
  const settle = () => {
    if (done.current || trailTop.current === null || stoneTop.current === null) return;
    done.current = true;
    const at = trailTop.current + stoneTop.current;
    if (at > height * 0.6) scroll.current?.scrollTo({ y: at - height * 0.3, animated: false });
  };
  return {
    scroll,
    onTrail: (event: LayoutChangeEvent) => {
      trailTop.current = event.nativeEvent.layout.y;
      settle();
    },
    onCurrent: (event: LayoutChangeEvent) => {
      stoneTop.current = event.nativeEvent.layout.y;
      settle();
    },
  };
}

function Skeleton() {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      accessible
      accessibilityLabel={t("common.loading")}
      accessibilityLiveRegion="polite"
      style={styles.skeleton}
    >
      <View style={[styles.bone, styles.boneTall]} />
      <View style={styles.bone} />
      <View style={styles.bone} />
      <View style={styles.bone} />
    </View>
  );
}

function Loaded({
  rewards,
  me,
  onTrail,
  onCurrent,
}: Readonly<{
  rewards: LevelRewards;
  me: Me;
  onTrail: (event: LayoutChangeEvent) => void;
  onCurrent: (event: LayoutChangeEvent) => void;
}>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const stones = stonesOf(rewards);
  const next = nextReward(stones);
  return (
    <>
      <LevelPlaque rewards={rewards} />
      {next === null ? null : <NextRewardCard level={next.level} item={next.item} me={me} />}
      <AppText variant="title" accessibilityRole="header">
        {t("journey.levels")}
      </AppText>
      <View onLayout={onTrail} style={styles.trail}>
        <LevelTrail stones={stones} me={me} onCurrent={onCurrent} />
      </View>
      {rewards.achievements.length === 0 ? null : (
        <>
          <AppText variant="title" accessibilityRole="header">
            {t("journey.achievements")}
          </AppText>
          <AchievementRewards rewards={rewards.achievements} me={me} />
        </>
      )}
    </>
  );
}

/** The signed-in player's Journey: reads on every focus, and again after a sync that wrote something. */
function JourneyBody({ me }: Readonly<{ me: Me }>) {
  const { t } = useI18n();
  const { syncNow, version } = useQuestifySync();
  useFocusEffect(
    useCallback(() => {
      syncNow();
    }, [syncNow]),
  );
  const read = useRead(() => fetchLevelRewards(api.session), [version]);
  const { scroll, onTrail, onCurrent } = useScrollToCurrent();
  return (
    <ScrollView ref={scroll} contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
      {read.failed ? (
        <>
          <AppText accessibilityRole="alert">{t("journey.failed")}</AppText>
          <Button
            kind="quiet"
            label={t("common.retry")}
            onPress={read.retry}
            disabled={read.retrying}
          />
        </>
      ) : null}
      {read.data === null ? (
        read.failed ? null : (
          <Skeleton />
        )
      ) : (
        <Loaded rewards={read.data} me={me} onTrail={onTrail} onCurrent={onCurrent} />
      )}
    </ScrollView>
  );
}

/**
 * Journey (T-404d, ADR-767, Q-724), the fourth tab outside events: your level, the next level's item, and every item a
 * level or an achievement unlocks, reached or still ahead. Nothing on it has a price. Signed out, it asks for a sign-in
 * like every Questify tab.
 */
export function JourneyScreen() {
  const { t } = useI18n();
  const { state } = usePlayer();
  const me = state.status === "signed_in" ? state.me : undefined;
  return (
    <Screen title={t("nav.journey")}>
      {me === undefined ? <ProfileGate /> : <JourneyBody me={me} />}
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  skeleton: { gap: theme.spacing.md },
  bone: {
    height: 72,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  boneTall: { height: 132, borderRadius: theme.radius.lg },
  trail: { paddingTop: theme.spacing.xs },
});
