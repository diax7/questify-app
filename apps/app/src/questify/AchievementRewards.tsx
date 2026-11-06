import { Ionicons } from "@expo/vector-icons";
import type { AchievementReward, Theme } from "@questify/shared";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import type { Me } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { AchievementBadge, TIER_COLOR } from "#src/questify/AchievementBadge.tsx";
import { ItemPreview } from "#src/questify/ItemPreview.tsx";
import {
  achievementLabel,
  achievementState,
  reachLine,
  type RewardState,
} from "#src/questify/journey.ts";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

const BADGE = 56;
const STATE_ICON = {
  owned: "checkmark-circle",
  soon: "hourglass-outline",
  locked: "lock-closed",
} as const satisfies Record<RewardState, string>;

/**
 * One achievement that unlocks an item: its badge, the tier medal and a state icon, the item's name and, while the tier
 * is ahead, "Reach gold in Wanderer". An owned item opens the locker on its tab. No price: the tier opens it.
 */
function RewardCard({ reward, me }: Readonly<{ reward: AchievementReward; me: Me }>) {
  const { t, language } = useI18n();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const state = achievementState(reward);
  const name = reward.name[language];
  const open =
    state === "owned"
      ? () => router.push({ pathname: "/locker", params: { kind: reward.item.kind } })
      : undefined;
  return (
    <Pressable
      accessible
      accessibilityRole={open === undefined ? "text" : "button"}
      accessibilityLabel={achievementLabel(t, language, reward)}
      {...(open === undefined ? {} : { accessibilityHint: t("locker.title") })}
      onPress={open}
      style={styles.card}
    >
      <AchievementBadge
        visualKey={reward.visualKey}
        tier={reward.earned ? reward.tier : null}
        letter={Array.from(name)[0] ?? "?"}
        size={BADGE}
      />
      <View style={styles.text}>
        <AppText variant="label" numberOfLines={2}>
          {name}
        </AppText>
        <View style={styles.icons}>
          <Ionicons name="medal" size={20} color={theme.colors[TIER_COLOR[reward.tier]]} />
          <Ionicons
            name={STATE_ICON[state]}
            size={20}
            color={state === "locked" ? theme.colors.textMuted : theme.colors.tierGold}
          />
        </View>
        <AppText numberOfLines={2}>{reward.item.name[language]}</AppText>
        {state === "locked" ? (
          <AppText muted numberOfLines={2}>
            {reachLine(t, language, reward)}
          </AppText>
        ) : null}
      </View>
      <ItemPreview item={reward.item} me={me} size={48} locked={state !== "owned"} />
    </Pressable>
  );
}

/** The achievements that unlock an item (the server lists only those), in the order it gives them. */
export function AchievementRewards({
  rewards,
  me,
}: Readonly<{ rewards: readonly AchievementReward[]; me: Me }>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.list}>
      {rewards.map((reward) => (
        <RewardCard key={reward.id} reward={reward} me={me} />
      ))}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  list: { gap: theme.spacing.md },
  card: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  text: { flex: 1, gap: 2 },
  icons: { flexDirection: "row" as const, alignItems: "center" as const, gap: theme.spacing.xs },
});
