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
  shownNotice,
  type Invitation,
  type JoinOutcome,
} from "#src/join/join-api.ts";
import { isInEvent, joinedResult, type Joined } from "#src/join/join-result.ts";
import { JoinForm } from "#src/join/JoinForm.tsx";
import { pointAtMissing, refusalOf, type Pointed } from "#src/join/pointed.ts";
import { openJoinedEvent } from "#src/onboarding/open-joined.ts";
import { PushExplainer, useJoinExplainer } from "#src/push/PushExplainer.tsx";
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

/** What a join that went through says, and the way into the event. */
function InviteJoined({ joined, eventName }: Readonly<{ joined: Joined; eventName: string }>) {
  const { t } = useI18n();
  return (
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
        onPress={() =>
          void openJoinedEvent(joined.eventId, eventName, isInEvent(joinedResult(joined)))
        }
      />
    </>
  );
}

const NOTICE_TEXT = {
  loading: "common.loading",
  gone: "join.notFound",
  network: "join.network",
} as const;

/** The screen before the invitation is there: loading, gone, or a failed read with Retry. */
function InviteNotice({
  loaded,
  load,
}: Readonly<{ loaded: Exclude<Loaded, Invitation>; load: () => Promise<void> }>) {
  const { t } = useI18n();
  return (
    <Screen title={t("invitations.title")}>
      <AppText>{t(NOTICE_TEXT[loaded ?? "loading"])}</AppText>
      {loaded === "network" ? (
        <Button label={t("common.retry")} onPress={() => void load()} />
      ) : null}
    </Screen>
  );
}

/** What the screen sets from a join's answer. */
type OutcomeSinks = Readonly<{
  setJoined: (joined: Joined) => void;
  setPointed: (pointed: Pointed | undefined) => void;
  setProblem: (problem: LocalizedText | null) => void;
  reload: () => void;
}>;

/** Shows what a join's answer says: the way into the event, the field to fix, the refusal, or a new card. */
function applyOutcome(outcome: JoinOutcome, sinks: OutcomeSinks) {
  if (outcome.kind === "joined") {
    sinks.setJoined(outcome);
  } else if (outcome.kind === "invalid_answers") {
    sinks.setPointed(refusalOf(outcome).pointed);
    sinks.setProblem(refusalOf(outcome).problem);
  } else if (outcome.kind === "refused") {
    sinks.setProblem(outcome.problem);
  } else if (outcome.kind === "stale") {
    sinks.reload();
  } else if (outcome.kind === "signed_out") {
    router.replace("/sign-in");
  } else {
    sinks.setProblem(MESSAGES["join.network"]);
  }
}

/** The invitation's details and the join: the form and Join before it, the welcome and the way in after. */
function InviteDetails({
  invitation,
  joined,
  typed,
  onType,
  pointed,
  problem,
  busy,
  full,
  onJoin,
}: Readonly<{
  invitation: Invitation;
  joined: Joined | undefined;
  typed: Typed;
  onType: (typed: Typed) => void;
  pointed: Pointed | undefined;
  problem: LocalizedText | null;
  busy: boolean;
  full: boolean;
  onJoin: () => void;
}>) {
  const { t, language } = useI18n();
  const { event, card } = invitation;
  return (
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
          onType={onType}
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
          onPress={onJoin}
        />
      ) : (
        <InviteJoined joined={joined} eventName={textIn(event.name, language)} />
      )}
    </ScrollView>
  );
}

/**
 * "You're invited" (FR-133): an event whose guest list holds the player's phone or email, joined without a code and,
 * for a private event, without waiting for approval (FR-1819). The card and the join fields are the event's own. A full
 * event offers its waiting list (FR-1821).
 */
export default function InviteScreen() {
  const { language } = useI18n();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { loaded, load } = useInvitation(String(eventId));
  const [typed, setTyped] = useState<Typed>({});
  const [pointed, setPointed] = useState<Pointed | undefined>(undefined);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [joined, setJoined] = useState<Joined | undefined>();
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  const explainer = useJoinExplainer(joined !== undefined);

  if (loaded === undefined || loaded === "gone" || loaded === "network") {
    return <InviteNotice loaded={loaded} load={load} />;
  }
  const { event, card } = loaded;

  const tapJoin = async (waitlist = false) => {
    const missing = firstMissing(event.join.fields, typed);
    setPointed(pointAtMissing(missing));
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
        nameNotice: shownNotice(card),
        answers: answersFor(event.join.fields, typed),
      },
      waitlist,
    );
    setBusy(false);
    setFull(outcome.kind === "refused" && outcome.code === "event_full");
    applyOutcome(outcome, { setJoined, setPointed, setProblem, reload: () => void load() });
  };

  return (
    <Screen title={textIn(event.name, language)}>
      <PushExplainer explainer={explainer} />
      <InviteDetails
        invitation={loaded}
        joined={joined}
        typed={typed}
        onType={setTyped}
        pointed={pointed}
        problem={problem}
        busy={busy}
        full={full}
        onJoin={() => void tapJoin(full)}
      />
    </Screen>
  );
}
