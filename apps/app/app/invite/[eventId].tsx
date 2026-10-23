import { MESSAGES, type LocalizedText } from "@questify/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { answersFor, firstMissing, type Typed } from "#src/join/answers.ts";
import { CardReceives } from "#src/join/CardReceives.tsx";
import {
  fetchInvitations,
  joinInvitation,
  type Invitation,
  type JoinOutcome,
} from "#src/join/join-api.ts";
import { JoinForm } from "#src/join/JoinForm.tsx";
import { WelcomeReward } from "#src/join/WelcomeReward.tsx";

type Loaded = Invitation | "gone" | "network" | undefined;

/** The invitation for this event, read again from the list: one that is no longer there is gone. */
function useInvitation(eventId: string) {
  const [loaded, setLoaded] = useState<Loaded>(undefined);
  const load = useCallback(async () => {
    const answer = await fetchInvitations(api.session);
    if (answer.kind === "signed_out") {
      router.replace("/sign-in");
      return;
    }
    setLoaded(
      answer.kind === "list"
        ? (answer.invitations.find((item) => item.event.id === eventId) ?? "gone")
        : "network",
    );
  }, [eventId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { loaded, load };
}

/**
 * "You're invited" (FR-133): an event whose guest list holds the player's phone or email, joined without a code and,
 * for a private event, without waiting for approval (FR-1819). The card and the join fields are the event's own. A full
 * event offers its waiting list (FR-1821).
 */
export default function InviteScreen() {
  const { t, language } = useI18n();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { loaded, load } = useInvitation(String(eventId));
  const [typed, setTyped] = useState<Typed>({});
  const [pointed, setPointed] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [joined, setJoined] = useState<Extract<JoinOutcome, { kind: "joined" }> | undefined>();
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);

  if (loaded === undefined || loaded === "gone" || loaded === "network") {
    return (
      <Screen title={t("invitations.title")}>
        <AppText>
          {t(
            loaded === undefined
              ? "common.loading"
              : loaded === "gone"
                ? "join.notFound"
                : "join.network",
          )}
        </AppText>
        {loaded === "network" ? (
          <Button label={t("common.retry")} onPress={() => void load()} />
        ) : null}
      </Screen>
    );
  }
  const { event, card } = loaded;

  const tapJoin = async (waitlist = false) => {
    const missing = firstMissing(event.join.fields, typed);
    setPointed(missing);
    if (missing !== undefined) {
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await joinInvitation(
      api.session,
      {
        eventId: event.id,
        cardVersion: card.version,
        answers: answersFor(event.join.fields, typed),
      },
      waitlist,
    );
    setBusy(false);
    setFull(outcome.kind === "refused" && outcome.code === "event_full");
    if (outcome.kind === "joined") {
      setJoined(outcome);
    } else if (outcome.kind === "invalid_answers") {
      setPointed(outcome.field ?? undefined);
      setProblem(outcome.problem);
    } else if (outcome.kind === "refused") {
      setProblem(outcome.problem);
    } else if (outcome.kind === "stale") {
      void load();
    } else if (outcome.kind === "signed_out") {
      router.replace("/sign-in");
    } else {
      setProblem(MESSAGES["join.network"]);
    }
  };

  return (
    <Screen title={textIn(event.name, language)}>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        <AppText variant="title">{t("invitations.title")}</AppText>
        {textIn(event.venue, language) === "" ? null : (
          <AppText muted>{textIn(event.venue, language)}</AppText>
        )}
        <CardReceives card={card} />
        {joined === undefined ? (
          <JoinForm
            rules={event.join}
            typed={typed}
            onType={setTyped}
            pointed={pointed}
            showLocks={false}
          />
        ) : null}
        {joined !== undefined && joined.welcome > 0 ? (
          <WelcomeReward points={joined.welcome} />
        ) : null}
        <Problem problem={problem} />
        {joined === undefined ? (
          <Button
            label={t(full ? "join.waitlistJoin" : "joinCard.join")}
            disabled={busy}
            onPress={() => void tapJoin(full)}
          />
        ) : (
          <>
            <AppText>
              {t(
                joined.alreadyMember
                  ? "join.already"
                  : joined.waitlisted
                    ? "join.waitlisted"
                    : "join.active",
              )}
            </AppText>
            <Button
              label={t("joinCard.openEvent")}
              onPress={() => router.replace(`/event/${joined.eventId}`)}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
