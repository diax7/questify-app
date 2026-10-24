import { formatEventTime, type Language, type OfficialRules } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, ScrollView } from "react-native";
import { router } from "expo-router";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { fetchHome, type HomeAnswer } from "#src/event/home-api.ts";
import { fetchRules, type RulesAnswer } from "#src/event/rules-api.ts";
import { forget } from "#src/event/launch.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";

/** The phone's maps app, searching the venue's words (the event has no address or position yet: Q-099). */
const mapsLink = (venue: string): string =>
  Platform.OS === "ios"
    ? `https://maps.apple.com/?q=${encodeURIComponent(venue)}`
    : `geo:0,0?q=${encodeURIComponent(venue)}`;

/** The event's official rules, written in the app (FR-1707, ADR-165): Questify's fixed part, then the organizer's. */
function RulesSection({ rules, language }: Readonly<{ rules: OfficialRules; language: Language }>) {
  const { t } = useI18n();
  const own = rules.text[language] ?? rules.text[language === "ar" ? "en" : "ar"];
  return (
    <>
      <AppText variant="title">{t("info.rules")}</AppText>
      {(rules.block?.[language] ?? []).map((line) => (
        <AppText key={line}>{line}</AppText>
      ))}
      {own === null ? null : (
        <>
          <AppText variant="label">{t("rules.organizerText")}</AppText>
          <AppText>{own}</AppText>
        </>
      )}
    </>
  );
}

/**
 * The event's information (FR-805, in part): its venue and dates in the event's own zone, and its official rules when
 * it has any (FR-1707).
 */
export default function EventInfoScreen() {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const [answer, setAnswer] = useState<HomeAnswer | undefined>(undefined);
  const [mapsFailed, setMapsFailed] = useState(false);
  const [rules, setRules] = useState<RulesAnswer | undefined>(undefined);
  const load = useCallback(async () => {
    const loaded = await fetchHome(api.session, eventId);
    // As on Home: only the server's definite answer forgets the event.
    if (loaded.kind === "gone") {
      await forget(keyValueStore, eventId);
      router.replace("/home");
      return;
    }
    if (loaded.kind === "signed_out") {
      router.replace("/home");
      return;
    }
    setAnswer(loaded);
  }, [eventId]);
  useEffect(() => {
    void load();
    void fetchRules(api.session, eventId).then(setRules);
  }, [load, eventId]);

  if (answer?.kind !== "home") {
    return (
      <Screen title={t("eventHome.info")} header={<BackButton />}>
        {answer === undefined ? (
          <AppText muted>{t("common.loading")}</AppText>
        ) : (
          <>
            <AppText accessibilityRole="alert">{t("eventHome.loadFailed")}</AppText>
            <Button label={t("common.retry")} onPress={() => void load()} />
          </>
        )}
      </Screen>
    );
  }
  const { event } = answer.home;
  const venue = textIn(event.venue, language);
  const when = (iso: string | null, key: "eventInfo.starts" | "eventInfo.ends") =>
    iso === null ? null : (
      <AppText>
        {t(key, { time: formatEventTime(new Date(iso), event.timezone, language) })}
      </AppText>
    );
  return (
    <Screen title={textIn(event.name, language)} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        {venue === "" ? null : (
          <>
            <AppText variant="title">{t("eventInfo.venue")}</AppText>
            <AppText>{venue}</AppText>
            <Button
              kind="quiet"
              label={t("eventInfo.openMaps")}
              onPress={() => {
                setMapsFailed(false);
                Linking.openURL(mapsLink(venue)).catch(() => setMapsFailed(true));
              }}
            />
            {mapsFailed ? (
              <AppText accessibilityRole="alert">{t("eventInfo.mapsFailed")}</AppText>
            ) : null}
          </>
        )}
        <AppText variant="title">{t("eventInfo.when")}</AppText>
        {when(event.startsAt, "eventInfo.starts")}
        {when(event.endsAt, "eventInfo.ends")}
        {rules?.kind === "rules" ? <RulesSection rules={rules.rules} language={language} /> : null}
        <Button
          kind="quiet"
          label={t("help.open")}
          onPress={() => router.push(`/event/${eventId}/help`)}
        />
      </ScrollView>
    </Screen>
  );
}
