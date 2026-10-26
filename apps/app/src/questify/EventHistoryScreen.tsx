import { formatLocalDate, type OwnEvent, type Theme } from "@questify/shared";
import { ScrollView, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { wordsIn } from "#src/questify/PassportSection.tsx";
import { useQuestifySync } from "#src/questify/QuestifySyncProvider.tsx";
import { stampState, stateText } from "#src/questify/stamps.ts";
import { useEventPages } from "#src/questify/use-read.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

const MEMBERSHIP_NOTE = {
  left: "eventHistory.left",
  removed: "eventHistory.removed",
  banned: "eventHistory.banned",
} as const;

function Row({ event }: Readonly<{ event: OwnEvent }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const text = stateText(stampState(event));
  const where = event.city === null ? null : wordsIn(event.city, language);
  const note = event.memberStatus === "active" ? null : MEMBERSHIP_NOTE[event.memberStatus];
  return (
    <View accessible style={styles.row}>
      <AppText variant="label">{wordsIn(event.name, language)}</AppText>
      <AppText muted>
        {[formatLocalDate(event.date, language), where].filter((part) => part !== null).join(" · ")}
      </AppText>
      <AppText>{t(text.key, text.params)}</AppText>
      {note === null ? null : <AppText muted>{t(note)}</AppText>}
    </View>
  );
}

/** Every event you joined, newest first (FR-701): yours alone, never shown to another player. */
export function EventHistoryScreen() {
  const { t } = useI18n();
  const { version } = useQuestifySync();
  const pages = useEventPages(false, [version]);
  return (
    <Screen title={t("eventHistory.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {pages.failed ? (
          <>
            <AppText accessibilityRole="alert">{t("eventHistory.failed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={pages.retry} />
          </>
        ) : null}
        {pages.rows === null && !pages.failed ? (
          <AppText muted>{t("common.loading")}</AppText>
        ) : null}
        {pages.rows?.length === 0 ? <AppText muted>{t("eventHistory.empty")}</AppText> : null}
        {(pages.rows ?? []).map((event) => (
          <Row key={event.eventId} event={event} />
        ))}
        {pages.more === null ? null : (
          <Button kind="quiet" label={t("locker.more")} onPress={pages.more} />
        )}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
