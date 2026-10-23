import { parseJoinLink, parseRehearsalCode, type Theme } from "@questify/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AddEmailCard } from "#src/account/AddEmailCard.tsx";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Field } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { usePlayer } from "#src/auth/player.tsx";
import { readMyEvents, readRecent, type MyEvent } from "#src/event/launch.ts";
import { OperatorEvents } from "#src/operator/OperatorEvents.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { fetchInvitations, type Invitation } from "#src/join/join-api.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Text = Readonly<{ ar: string | null; en: string | null }>;
type ListedEvent = Readonly<{
  id: string;
  joinCode: string;
  name: Text;
  status?: "active" | "pending";
}>;

const isText = (value: unknown): value is Text =>
  typeof value === "object" && value !== null && "ar" in value && "en" in value;

const listedEvents = (value: unknown): ListedEvent[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is ListedEvent =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as ListedEvent).id === "string" &&
          typeof (item as ListedEvent).joinCode === "string" &&
          isText((item as ListedEvent).name),
      )
    : [];

function CodeEntry() {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  const open = () => {
    const code = parseJoinLink(typed) ?? parseRehearsalCode(typed);
    if (code === null) {
      setWrong(true);
      return;
    }
    setWrong(false);
    router.push({ pathname: "/join/[code]", params: { code, via: "code" } });
  };
  return (
    <>
      <Field
        label={t("home.codeLabel")}
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        style={{ writingDirection: "ltr", textAlign: "left" }}
      />
      {wrong ? <AppText accessibilityRole="alert">{t("home.notACode")}</AppText> : null}
      <Button label={t("home.open")} disabled={typed.trim() === ""} onPress={open} />
    </>
  );
}

function EventRow({
  event,
  note,
  onPress,
}: Readonly<{ event: ListedEvent; note?: string | undefined; onPress: () => void }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const name =
    event.name[language] ?? event.name[language === "ar" ? "en" : "ar"] ?? event.joinCode;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row}>
      <AppText variant="label">{name}</AppText>
      {note === undefined ? null : <AppText muted>{note}</AppText>}
    </Pressable>
  );
}

/** Browse before sign-in (FR-104, FR-111): public events that list themselves, page by page. */
function PublicEvents() {
  const { t } = useI18n();
  const [events, setEvents] = useState<ListedEvent[] | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (cursor: string | null) => {
    const path =
      cursor === null
        ? "/v1/public/events"
        : `/v1/public/events?cursor=${encodeURIComponent(cursor)}`;
    const answer = await api.client.request({ method: "GET", path });
    if (answer.kind !== "ok" || typeof answer.body !== "object" || answer.body === null) {
      // A failed read is not an empty list: say so, with retry.
      setFailed(true);
      return;
    }
    setFailed(false);
    const body = answer.body as { events?: unknown; nextCursor?: unknown };
    setEvents((current) => [
      ...(cursor === null ? [] : (current ?? [])),
      ...listedEvents(body.events),
    ]);
    // The cursor is opaque (API.md): sent back as it came; a stale one starts again from the first page.
    setNext(typeof body.nextCursor === "string" && body.nextCursor !== "" ? body.nextCursor : null);
  }, []);
  useEffect(() => {
    void load(null);
  }, [load]);
  return (
    <>
      <AppText variant="title">{t("home.publicEvents")}</AppText>
      {failed ? (
        <>
          <AppText accessibilityRole="alert">{t("join.network")}</AppText>
          <Button
            kind="quiet"
            label={t("common.retry")}
            onPress={() => void load(events === undefined ? null : next)}
          />
        </>
      ) : null}
      {events === undefined && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
      {events?.length === 0 ? <AppText muted>{t("home.noPublic")}</AppText> : null}
      {(events ?? []).map((event) => (
        <EventRow
          key={event.id}
          event={event}
          onPress={() =>
            router.push({
              pathname: "/join/[code]",
              params: { code: event.joinCode, via: "public_list" },
            })
          }
        />
      ))}
      {next === null ? null : (
        <Button kind="quiet" label={t("home.more")} onPress={() => void load(next)} />
      )}
    </>
  );
}

/**
 * The player's events (FR-122): the one opened most recently on this phone first is marked; pending ones say so. A
 * failed read says so with a retry: it is never shown as "no events".
 */
function MyEvents() {
  const { t } = useI18n();
  const [events, setEvents] = useState<MyEvent[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [latest, setLatest] = useState<string | undefined>(undefined);
  const load = useCallback(async () => {
    setFailed(false);
    const answer = await api.session.request({ method: "GET", path: "/v1/me/events" });
    const read = answer.kind === "ok" ? readMyEvents(answer.body) : undefined;
    setFailed(read === undefined);
    setEvents(read);
    const recent = await readRecent(keyValueStore);
    setLatest(Object.entries(recent).toSorted((a, b) => b[1] - a[1])[0]?.[0]);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <AppText variant="title">{t("home.myEvents")}</AppText>
      {failed ? (
        <>
          <AppText accessibilityRole="alert">{t("home.eventsFailed")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
        </>
      ) : null}
      {events === undefined && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
      {events?.length === 0 ? <AppText muted>{t("home.noEvents")}</AppText> : null}
      {(events ?? []).map((event) => (
        <EventRow
          key={event.id}
          event={event}
          note={
            event.status === "pending"
              ? t("players.status.pending")
              : event.id === latest
                ? t("home.current")
                : undefined
          }
          onPress={() => router.replace(`/event/${event.id}`)}
        />
      ))}
    </>
  );
}

/** "You're invited" (FR-133): events whose guest list holds the player; nothing at all when there are none. */
function Invitations() {
  const { t } = useI18n();
  const [invitations, setInvitations] = useState<readonly Invitation[]>([]);
  useEffect(() => {
    void fetchInvitations(api.session).then((answer) => {
      if (answer.kind === "list") {
        setInvitations(answer.invitations);
      }
    });
  }, []);
  if (invitations.length === 0) {
    return null;
  }
  return (
    <>
      <AppText variant="title">{t("invitations.title")}</AppText>
      {invitations.map(({ event }) => (
        <EventRow
          key={event.id}
          event={{ id: event.id, joinCode: "", name: event.name }}
          note={t("invitations.open")}
          onPress={() =>
            router.push({ pathname: "/invite/[eventId]", params: { eventId: event.id } })
          }
        />
      ))}
    </>
  );
}

/**
 * Questify home (FR-623, T-111): a code or link to open an event's join card, the public list for someone not signed
 * in, and a player's events. Inside an event, its own Home takes over (T-113); this screen's own bar is T-408.
 */
export default function QuestifyHomeScreen() {
  const { t } = useI18n();
  const { state } = usePlayer();
  // Operator mode sends people here when the owner removed them (FR-905); an event Home when rehearsal ended (T-211).
  const { notice } = useLocalSearchParams<{ notice?: string }>();
  return (
    <Screen title={t("home.title")}>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        {notice === "operatorRemoved" ? (
          <AppText accessibilityRole="alert">{t("operator.removed")}</AppText>
        ) : null}
        {notice === "rehearsalEnded" ? (
          <AppText accessibilityRole="alert">{t("rehearsal.ended")}</AppText>
        ) : null}
        <CodeEntry />
        {state.status === "signed_in" ? (
          <>
            <AddEmailCard />
            <OperatorEvents />
            <Invitations />
            <MyEvents />
            <Button kind="quiet" label={t("nav.profile")} onPress={() => router.push("/profile")} />
          </>
        ) : null}
        {state.status === "signed_out" ? (
          <>
            {state.ended ? (
              <AppText accessibilityRole="alert">{t("signIn.sessionEnded")}</AppText>
            ) : null}
            <Button label={t("signIn.start")} onPress={() => router.push("/sign-in")} />
            <PublicEvents />
          </>
        ) : null}
        <View />
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
