import {
  formatEventTime,
  infoSections,
  type HomeContent,
  type InfoSection,
  type Language,
  type OfficialRules,
} from "@questify/shared";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { Linking, Platform, ScrollView } from "react-native";
import { router } from "expo-router";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { fetchHome, type Home, type HomeAnswer } from "#src/event/home-api.ts";
import { localIn } from "#src/event/home-content.ts";
import { contactRows, faqRows } from "#src/event/info-page.ts";
import { AboutSection, ContactsSection, FaqSection } from "#src/event/InfoSections.tsx";
import { fetchRules, type RulesAnswer } from "#src/event/rules-api.ts";
import { forget } from "#src/event/launch.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";

/** The phone's maps app, searching the venue's words (the venue text is the address; a map position is not stored, Q-365). */
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

/** The venue's words, with a button that opens the phone's maps app at them (FR-805). */
function VenueSection({ venue }: Readonly<{ venue: string }>) {
  const { t } = useI18n();
  const [mapsFailed, setMapsFailed] = useState(false);
  if (venue === "") {
    return null;
  }
  return (
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
      {mapsFailed ? <AppText accessibilityRole="alert">{t("eventInfo.mapsFailed")}</AppText> : null}
    </>
  );
}

/** The start and end in the event's own zone. */
function WhenSection({ event }: Readonly<{ event: Home["event"] }>) {
  const { t, language } = useI18n();
  const when = (iso: string | null, key: "eventInfo.starts" | "eventInfo.ends") =>
    iso === null ? null : (
      <AppText>
        {t(key, { time: formatEventTime(new Date(iso), event.timezone, language) })}
      </AppText>
    );
  return (
    <>
      <AppText variant="title">{t("eventInfo.when")}</AppText>
      {when(event.startsAt, "eventInfo.starts")}
      {when(event.endsAt, "eventInfo.ends")}
    </>
  );
}

/** The way to the agenda, for an event whose agenda is on (the section starts hidden). */
function ScheduleLink({ eventId }: Readonly<{ eventId: string }>) {
  const { t } = useI18n();
  return (
    <Button
      kind="quiet"
      label={t("agenda.link")}
      onPress={() => router.push(`/event/${eventId}/agenda`)}
    />
  );
}

type SectionParts = Readonly<{
  event: Home["event"];
  content: HomeContent;
  rules: RulesAnswer | undefined;
  language: Language;
  eventId: string;
}>;

/** What each section of the info page draws, or nothing when it has nothing to say (T-613). */
const SECTION_VIEWS: Readonly<Record<InfoSection, (parts: SectionParts) => ReactNode>> = {
  about: ({ content, language }) => {
    const text = localIn(content.about, language);
    return text === "" ? null : <AboutSection text={text} />;
  },
  venue: ({ event, language }) => <VenueSection venue={textIn(event.venue, language)} />,
  when: ({ event }) =>
    event.startsAt === null && event.endsAt === null ? null : <WhenSection event={event} />,
  schedule: ({ eventId }) => <ScheduleLink eventId={eventId} />,
  faq: ({ content, language }) => {
    const rows = faqRows(content.faq, language);
    return rows.length === 0 ? null : <FaqSection rows={rows} />;
  },
  contacts: ({ content, language }) => {
    const rows = contactRows(content.contacts, language);
    return rows.length === 0 ? null : <ContactsSection rows={rows} />;
  },
  rules: ({ rules, language }) =>
    rules?.kind === "rules" ? <RulesSection rules={rules.rules} language={language} /> : null,
};

/**
 * The event's information (FR-805, FR-1835): the sections the organizer chose, in the order they set, then the way to the help
 * desk. The venue and dates are read in the event's own zone, and the official rules show when it has any (FR-1707); they
 * cannot be hidden.
 */
export default function EventInfoScreen() {
  const { t, language } = useI18n();
  const { eventId, featureOn, layout } = useEvent();
  const [answer, setAnswer] = useState<HomeAnswer | undefined>(undefined);
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
  const parts = { event, content: layout.content, rules, language, eventId };
  return (
    <Screen title={textIn(event.name, language)} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        {infoSections(featureOn, layout.info).map((name) => (
          <Fragment key={name}>{SECTION_VIEWS[name](parts)}</Fragment>
        ))}
        <Button
          kind="quiet"
          label={t("help.open")}
          onPress={() => router.push(`/event/${eventId}/help`)}
        />
      </ScrollView>
    </Screen>
  );
}
