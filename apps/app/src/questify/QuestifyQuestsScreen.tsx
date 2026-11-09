import { router, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import type { QuestifyQuest, QuestifyQuests, Theme } from "@questify/shared";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { wordsIn } from "#src/questify/PassportSection.tsx";
import { useQuestifySync } from "#src/questify/QuestifySyncProvider.tsx";
import { fetchQuestifyQuests } from "#src/questify/questify-api.ts";
import { clampedProgress, endsIn, opensInterests } from "#src/questify/stamps.ts";
import { useRead } from "#src/questify/use-read.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

function QuestCard({ quest }: Readonly<{ quest: QuestifyQuest }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const shown = clampedProgress(quest.progress, quest.target);
  const progress = t("questifyQuests.progress", { progress: shown, target: quest.target });
  return (
    <View style={styles.card}>
      <AppText variant="label">{wordsIn(quest.title, language)}</AppText>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={progress}
        accessibilityValue={{ min: 0, max: quest.target, now: shown }}
        style={styles.track}
      >
        <View
          style={[
            styles.fill,
            quest.done && styles.fillDone,
            { width: `${(shown / quest.target) * 100}%` },
          ]}
        />
      </View>
      <View style={styles.line}>
        {opensInterests(quest) ? (
          <Button
            kind="quiet"
            label={t("questifyQuests.chooseInterests")}
            onPress={() => router.push("/interests")}
          />
        ) : (
          <AppText muted>{quest.done ? t("questifyQuests.done") : progress}</AppText>
        )}
        <View style={styles.rewards}>
          <AppText variant="label">{t("questifyQuests.xp", { xp: quest.xp })}</AppText>
        </View>
      </View>
    </View>
  );
}

/** What the list says before it has quests: the failure with Retry, the loading line, or that there are none. */
function ReadNotes({
  failed,
  retry,
  quests,
}: Readonly<{ failed: boolean; retry: () => void; quests: QuestifyQuests | null }>) {
  const { t } = useI18n();
  const empty = quests !== null && quests.alwaysOn.length === 0 && quests.seasonal.length === 0;
  return (
    <>
      {failed ? (
        <>
          <AppText accessibilityRole="alert">{t("questifyQuests.failed")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={retry} />
        </>
      ) : null}
      {quests === null && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
      {empty ? <AppText muted>{t("questifyQuests.empty")}</AppText> : null}
    </>
  );
}

function AlwaysOnSection({ quests }: Readonly<{ quests: readonly QuestifyQuest[] }>) {
  const { t } = useI18n();
  return quests.length === 0 ? null : (
    <>
      <AppText variant="title">{t("questifyQuests.alwaysOn")}</AppText>
      {quests.map((quest) => (
        <QuestCard key={quest.id} quest={quest} />
      ))}
    </>
  );
}

function CampaignSection({
  seasonal: { campaign, quests },
  now,
}: Readonly<{ seasonal: QuestifyQuests["seasonal"][number]; now: Date }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const left = endsIn(campaign.endsAt, now);
  return (
    <View style={styles.campaign}>
      <AppText variant="title">{wordsIn(campaign.name, language)}</AppText>
      {left === null ? null : <AppText muted>{t(left.key, { days: left.days })}</AppText>}
      {quests.map((quest) => (
        <QuestCard key={quest.id} quest={quest} />
      ))}
    </View>
  );
}

/** Always-on quests, then each campaign running now with the days it has left (FR-710, FR-711). */
export function QuestifyQuestsScreen() {
  const { t } = useI18n();
  const { syncNow, version } = useQuestifySync();
  useFocusEffect(
    useCallback(() => {
      syncNow();
    }, [syncNow]),
  );
  const read = useRead(() => fetchQuestifyQuests(api.session), [version]);
  const quests = read.data;
  const now = new Date();
  return (
    <Screen title={t("questifyQuests.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <ReadNotes failed={read.failed} retry={read.retry} quests={quests} />
        <AlwaysOnSection quests={quests?.alwaysOn ?? []} />
        {(quests?.seasonal ?? []).map((seasonal) => (
          <CampaignSection key={seasonal.campaign.id} seasonal={seasonal} now={now} />
        ))}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  campaign: { gap: theme.spacing.sm },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  // The bar fills from the start of the reading direction (the layout flips it in Arabic).
  track: {
    height: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.border,
    overflow: "hidden" as const,
    flexDirection: "row" as const,
  },
  fill: { height: 12, backgroundColor: theme.colors.highlight },
  fillDone: { backgroundColor: theme.colors.primaryAction },
  rewards: { flexDirection: "row" as const, gap: theme.spacing.md },
  line: { flexDirection: "row" as const, justifyContent: "space-between" as const },
});
