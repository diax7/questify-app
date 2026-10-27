import { formatEventTime, type ForYouEvent, type Theme } from "@questify/shared";
import { router } from "expo-router";
import { Pressable, ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { fetchForYou } from "#src/marketing/marketing-api.ts";
import { eventTitle } from "#src/marketing/for-you.ts";
import { useRead } from "#src/questify/use-read.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

function EventCard({ event }: Readonly<{ event: ForYouEvent }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const where = [event.city?.[language], event.venue[language]].filter(
    (part): part is string => part !== null && part !== undefined && part !== "",
  );
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        router.push({
          pathname: "/join/[code]",
          params: { code: event.joinCode, via: "public_list" },
        })
      }
      style={styles.card}
    >
      <AppText variant="label">{eventTitle(event, language)}</AppText>
      <AppText muted>
        {t(event.statusNow === "live" ? "forYou.live" : "forYou.upcoming")}
        {" · "}
        {formatEventTime(new Date(event.startsAt), event.timezone, language)}
      </AppText>
      {where.length === 0 ? null : <AppText muted>{where.join(" · ")}</AppText>}
    </Pressable>
  );
}

/**
 * "For you" (FR-734): public events that match the player's interests or city, read again each time the screen gains
 * focus. A failed read says so with a retry and is never shown as "nothing for you"; until Explore (T-408) this is
 * reached from Questify home.
 */
export function ForYouScreen() {
  const { t } = useI18n();
  const read = useRead(() => fetchForYou(api.session), []);
  return (
    <Screen title={t("forYou.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <AppText muted>{t("forYou.intro")}</AppText>
        {read.failed ? (
          <>
            <AppText accessibilityRole="alert">{t("forYou.failed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={read.retry} />
          </>
        ) : null}
        {read.data === null && !read.failed ? <AppText muted>{t("common.loading")}</AppText> : null}
        {read.data?.length === 0 ? <AppText muted>{t("forYou.none")}</AppText> : null}
        {(read.data ?? []).map((event) => (
          <EventCard key={event.id} event={event} />
        ))}
        <Button kind="quiet" label={t("forYou.choose")} onPress={() => router.push("/interests")} />
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
