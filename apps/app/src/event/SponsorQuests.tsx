import { formatNumber, tierKey, type MemberSponsor, type Theme } from "@questify/shared";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { Amount } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { fetchQuests, type Quest, type QuestsAnswer } from "#src/event/quests-api.ts";
import { stateLine } from "#src/event/QuestSheet.tsx";
import { narrowTo } from "#src/event/sponsors.ts";
import { useSponsors } from "#src/event/useSponsors.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

function QuestRow({ quest, eventId }: Readonly<{ quest: Quest; eventId: string }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const key = stateLine(quest);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/event/${eventId}/quests?quest=${quest.id}`)}
      style={styles.card}
    >
      <AppText variant="label">{textIn(quest.title, language)}</AppText>
      <Amount amount={formatNumber(quest.points, language)} form="compact" muted />
      {key === null ? null : <AppText muted>{t(key)}</AppText>}
    </Pressable>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

/** The line under the sponsor's name: its tier and its booth. */
function factsOf(sponsor: MemberSponsor, t: Translate): string {
  const booth = sponsor.booth === null ? [] : [t("sponsors.boothLine", { booth: sponsor.booth })];
  return [t(tierKey(sponsor.tier)), ...booth].join(" · ");
}

/** What the screen shows for the read: loading, a failure with retry, nothing yet, or the rows. */
function Quests({
  answer,
  quests,
  eventId,
  reload,
}: Readonly<{
  answer: QuestsAnswer | undefined;
  quests: readonly Quest[];
  eventId: string;
  reload: () => void;
}>) {
  const { t } = useI18n();
  if (answer === undefined) return <AppText muted>{t("common.loading")}</AppText>;
  if (answer.kind !== "quests") {
    return (
      <>
        <AppText accessibilityRole="alert">{t("questsTab.loadFailed")}</AppText>
        <Button label={t("common.retry")} onPress={reload} />
      </>
    );
  }
  if (quests.length === 0) return <AppText muted>{t("sponsors.screen.empty")}</AppText>;
  return (
    <>
      {quests.map((quest) => (
        <QuestRow key={quest.id} quest={quest} eventId={eventId} />
      ))}
    </>
  );
}

/** The quests one sponsor presents (FR-1307), opened from the sponsor strip; each opens its sheet on the Quests tab. */
export function SponsorScreen() {
  const { eventId = "", sponsor: sponsorId = "" } = useLocalSearchParams<{
    eventId: string;
    sponsor: string;
  }>();
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const lookup = useSponsors();
  const sponsor = lookup.byId(sponsorId);
  const [answer, setAnswer] = useState<QuestsAnswer | undefined>(undefined);
  const load = useCallback(
    async () => setAnswer(await fetchQuests(api.session, eventId)),
    [eventId],
  );
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const quests = useMemo(
    () =>
      answer?.kind === "quests"
        ? narrowTo(answer.view.categories, sponsorId, lookup).flatMap((category) => category.quests)
        : [],
    [answer, sponsorId, lookup],
  );
  if (sponsor === undefined) {
    // Not in the read yet is loading; in a read that answered it is a sponsor that was deleted since.
    return (
      <Screen title="">
        <BackButton />
        <AppText muted>{t(lookup.read ? "sponsors.screen.gone" : "common.loading")}</AppText>
      </Screen>
    );
  }
  return (
    <Screen title={textIn(sponsor.name, language)}>
      <BackButton />
      <AppText muted>{factsOf(sponsor, t)}</AppText>
      <ScrollView contentContainerStyle={styles.list}>
        <Quests answer={answer} quests={quests} eventId={eventId} reload={() => void load()} />
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  list: { gap: theme.spacing.md },
  card: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
