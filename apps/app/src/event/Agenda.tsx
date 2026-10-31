import {
  formatNumber,
  formatTimeWindow,
  termFor,
  type MemberSession,
  type Theme,
} from "@questify/shared";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import {
  cancelRegistration,
  fetchAgenda,
  offerOf,
  registerFor,
  noteKeyOf,
  seatsLeftOf,
  shownSessions,
  statusKeyOf,
  type AgendaAct,
} from "#src/event/agenda.ts";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function useAgendaReads(eventId: string) {
  const [sessions, setSessions] = useState<readonly MemberSession[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = async () => {
        const read = await fetchAgenda(api.session, eventId);
        if (!active) return;
        if (read.kind === "signed_out") router.replace("/sign-in");
        else if (read.kind === "agenda") setSessions(read.sessions);
        setFailed(read.kind === "network");
      };
      void load();
      const timer = setInterval(() => void load(), 30_000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [eventId, attempt]),
  );
  return { sessions, failed, reload: () => setAttempt((value) => value + 1) };
}

type Pending =
  | Readonly<{ kind: "overlap"; session: MemberSession; titles: string }>
  | Readonly<{ kind: "cancel"; session: MemberSession }>;

function SessionDetails({ session, zone }: Readonly<{ session: MemberSession; zone: string }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const place = textIn(session.place, language);
  const description = textIn(session.description, language);
  const starts = new Date(session.startsAt);
  const ends = new Date(session.endsAt);
  return (
    <>
      <AppText variant="label">{textIn(session.title, language)}</AppText>
      <AppText muted>
        {t(`agenda.kind.${session.kind}`)} · {formatTimeWindow(starts, ends, zone, language)}
      </AppText>
      {place === "" ? null : <AppText>{place}</AppText>}
      {session.speakers.length === 0 ? null : (
        <AppText>{t("agenda.speakers", { names: session.speakers.join(", ") })}</AppText>
      )}
      {description === "" ? null : <AppText>{description}</AppText>}
      {session.points === 0 ? null : (
        <AppText>
          {t("agenda.points", {
            points: formatNumber(session.points, language),
            currency: termFor(terms.currency, language, session.points),
          })}
        </AppText>
      )}
    </>
  );
}

function SessionOffers({
  session,
  busy,
  eventId,
  onRegister,
  onCancel,
}: Readonly<{
  session: MemberSession;
  busy: boolean;
  eventId: string;
  onRegister: () => void;
  onCancel: () => void;
}>) {
  const { t, language } = useI18n();
  const offer = offerOf(session);
  const statusKey = statusKeyOf(session);
  const note = noteKeyOf(session);
  const seatsLeft = seatsLeftOf(session);
  return (
    <>
      {seatsLeft === null ? null : (
        <AppText muted>
          {t("agenda.seatsLeft", { count: formatNumber(seatsLeft, language) })}
        </AppText>
      )}
      {statusKey === null ? null : <AppText variant="label">{t(statusKey)}</AppText>}
      {offer === "register" ? (
        <Button label={t("agenda.register")} disabled={busy} onPress={onRegister} />
      ) : null}
      {offer === "cancel" ? (
        <Button kind="quiet" label={t("agenda.cancel")} disabled={busy} onPress={onCancel} />
      ) : null}
      {note === null ? null : <AppText muted>{t(note)}</AppText>}
      {session.quest === null ? null : (
        <Button
          kind="quiet"
          label={t("agenda.quest", { title: textIn(session.quest.title, language) })}
          onPress={() => router.push(`/event/${eventId}/quests`)}
        />
      )}
    </>
  );
}

function SessionCard({
  session,
  zone,
  ...offers
}: Readonly<{
  session: MemberSession;
  zone: string;
  busy: boolean;
  eventId: string;
  onRegister: () => void;
  onCancel: () => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.card}>
      <SessionDetails session={session} zone={zone} />
      <SessionOffers session={session} {...offers} />
    </View>
  );
}

function usePendingActions(eventId: string, reload: () => void) {
  const { t, language } = useI18n();
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (run: () => Promise<AgendaAct>, session: MemberSession) => {
    setBusy(true);
    setProblem(null);
    const result = await run();
    setBusy(false);
    if (result.kind === "signed_out") {
      router.replace("/sign-in");
      return;
    }
    if (result.kind === "overlap") {
      const titles = result.titles.map((title) => title[language]).join(", ");
      setPending({ kind: "overlap", session, titles });
      return;
    }
    setPending(null);
    if (result.kind === "refused")
      setProblem(result.message?.[language] ?? t("agenda.actionFailed"));
    else if (result.kind === "network") setProblem(t("agenda.actionFailed"));
    reload();
  };
  const register = (session: MemberSession, confirmOverlap: boolean) =>
    act(
      () =>
        registerFor(api.session, eventId, session.id, {
          confirmOverlap,
          idempotencyKey: randomUuid(),
        }),
      session,
    );
  const cancel = (session: MemberSession) =>
    act(() => cancelRegistration(api.session, eventId, session.id, randomUuid()), session);
  return { pending, setPending, problem, busy, register, cancel };
}

function PendingSheet({
  pending,
  busy,
  close,
  onConfirm,
}: Readonly<{ pending: Pending | null; busy: boolean; close: () => void; onConfirm: () => void }>) {
  const { t, language } = useI18n();
  if (pending === null) return null;
  const overlap = pending.kind === "overlap";
  return (
    <Sheet
      visible
      title={t(overlap ? "agenda.overlapTitle" : "agenda.cancelTitle")}
      closeLabel={t(overlap ? "common.cancel" : "agenda.keep")}
      onClose={close}
    >
      <AppText>
        {overlap
          ? t("agenda.overlapBody", { titles: pending.titles })
          : t("agenda.cancelBody", { title: textIn(pending.session.title, language) })}
      </AppText>
      <Button
        label={t(overlap ? "agenda.overlapConfirm" : "agenda.cancel")}
        disabled={busy}
        onPress={onConfirm}
      />
    </Sheet>
  );
}

type Actions = ReturnType<typeof usePendingActions>;

function AgendaRows({
  eventId,
  zone,
  mine,
  reads,
  actions,
}: Readonly<{
  eventId: string;
  zone: string;
  mine: boolean;
  reads: ReturnType<typeof useAgendaReads>;
  actions: Actions;
}>) {
  const { t } = useI18n();
  const rows = shownSessions(reads.sessions, mine);
  return (
    <>
      {reads.failed ? (
        <>
          <AppText>{t("agenda.loadFailed")}</AppText>
          <Button label={t("common.retry")} onPress={reads.reload} />
        </>
      ) : null}
      {reads.sessions === undefined && !reads.failed ? (
        <AppText>{t("common.loading")}</AppText>
      ) : null}
      {reads.sessions !== undefined && rows.length === 0 ? (
        <AppText>{t(mine ? "agenda.emptyMine" : "agenda.empty")}</AppText>
      ) : null}
      {actions.problem === null ? null : (
        <AppText accessibilityRole="alert">{actions.problem}</AppText>
      )}
      {rows.map((session) => (
        <SessionCard
          key={session.id}
          session={session}
          zone={zone}
          busy={actions.busy}
          eventId={eventId}
          onRegister={() => void actions.register(session, false)}
          onCancel={() => actions.setPending({ kind: "cancel", session })}
        />
      ))}
    </>
  );
}

export function AgendaScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { t } = useI18n();
  const { events } = useEvent();
  const styles = useThemedStyles(makeStyles);
  const reads = useAgendaReads(eventId);
  const actions = usePendingActions(eventId, reads.reload);
  const [mine, setMine] = useState(false);
  const zone = events?.find((event) => event.id === eventId)?.timezone ?? deviceZone();
  return (
    <Screen title={t("agenda.title")}>
      <BackButton />
      <View style={styles.tabs}>
        <Button
          kind={mine ? "quiet" : "primary"}
          selected={!mine}
          label={t("agenda.all")}
          onPress={() => setMine(false)}
        />
        <Button
          kind={mine ? "primary" : "quiet"}
          selected={mine}
          label={t("agenda.mine")}
          onPress={() => setMine(true)}
        />
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        <AgendaRows eventId={eventId} zone={zone} mine={mine} reads={reads} actions={actions} />
      </ScrollView>
      <PendingSheet
        pending={actions.pending}
        busy={actions.busy}
        close={() => actions.setPending(null)}
        onConfirm={() => {
          const pending = actions.pending;
          if (pending === null) return;
          void (pending.kind === "overlap"
            ? actions.register(pending.session, true)
            : actions.cancel(pending.session));
        }}
      />
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  list: { gap: theme.spacing.md },
  tabs: { flexDirection: "row" as const, gap: theme.spacing.sm },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
  },
});
