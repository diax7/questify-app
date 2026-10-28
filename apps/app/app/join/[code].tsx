import { parseRehearsalCode, type LocalizedText, type MessageKey } from "@questify/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { usePlayer } from "#src/auth/player.tsx";
import type { PendingJoin } from "#src/auth/sign-in-flow.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import {
  answersFor,
  firstMissing,
  heldAnswers,
  holdAnswers,
  type Typed,
} from "#src/join/answers.ts";
import {
  fetchCard,
  joinEvent,
  type CardAnswer,
  type JoinCard,
  type JoinOutcome,
} from "#src/join/join-api.ts";
import { CardReceives } from "#src/join/CardReceives.tsx";
import { JoinForm } from "#src/join/JoinForm.tsx";
import { RehearsalJoin } from "#src/join/RehearsalJoin.tsx";
import { PushExplainer, useJoinExplainer } from "#src/push/PushExplainer.tsx";
import { WelcomeReward } from "#src/join/WelcomeReward.tsx";

type Via = PendingJoin["via"];

const VIAS: readonly Via[] = ["code", "qr", "link", "public_list"];

/** What the screen says for each state and outcome (the API's own message for its refusals). */
const OUTCOME_KEY = {
  active: "join.active",
  pending: "join.pending",
  waitlisted: "join.waitlisted",
  full: "join.full",
  already: "join.already",
  network: "join.network",
  not_found: "join.notFound",
  throttled: "join.throttled",
  stale: "join.stale",
} as const satisfies Readonly<Record<string, MessageKey>>;

type Outcome = keyof typeof OUTCOME_KEY;

const isOutcome = (value: unknown): value is Outcome =>
  typeof value === "string" && value in OUTCOME_KEY;

const welcomeOf = (value: unknown): number => {
  const points = Number(value);
  return Number.isInteger(points) && points > 0 ? points : 0;
};

/** The join button: the waiting list once the event said it is full (FR-1821), a request for a Private event (FR-1818). */
const joinLabel = (full: boolean, isPrivate: boolean): MessageKey =>
  full ? "join.waitlistJoin" : isPrivate ? "joinCard.request" : "joinCard.join";

/** The card by its code; `card` alone is replaced when a join says it changed. */
function useCard(code: string) {
  const [answer, setAnswer] = useState<CardAnswer | undefined>(undefined);
  const [card, setCard] = useState<JoinCard | undefined>(undefined);
  const load = useCallback(async () => {
    const loaded = await fetchCard(api.client, code);
    setAnswer(loaded);
    if (loaded.kind === "card") {
      setCard(loaded.card);
    }
  }, [code]);
  useEffect(() => {
    void load();
  }, [load]);
  return { answer, card, setCard, load };
}

/**
 * The join card (FR-121, FR-111, FR-112, FR-130): the event, what the organizer will see, the event's join fields and
 * locks, one Join button. Anyone can read it; Join asks a signed-out person to sign in first, and the join (with the
 * answers, held in memory) goes through only after that succeeds. A join that grants the welcome reward plays it once.
 * A rehearsal code (XXXX-XXXX, T-211) opens the rehearsal join instead.
 */
export default function JoinScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const rehearsal = parseRehearsalCode(String(code));
  return rehearsal === null ? <JoinCardScreen /> : <RehearsalJoin code={rehearsal} />;
}

/** What a join that went through says: the waiting list and a request still waiting before "already in". */
const joinedResult = (outcome: Extract<JoinOutcome, { kind: "joined" }>): Outcome =>
  outcome.waitlisted
    ? "waitlisted"
    : outcome.alreadyMember && outcome.status === "active"
      ? "already"
      : outcome.status;

type JoinParams = Readonly<{
  code: string;
  via?: string;
  outcome?: string;
  problemAr?: string;
  problemEn?: string;
  welcome?: string;
}>;

/** The join's state and the Join tap: answers checked, sign-in first when needed, then the outcome shown. */
function useJoinFlow(params: JoinParams, code: string, cardState: ReturnType<typeof useCard>) {
  const { state: player } = usePlayer();
  const { answer, card, setCard, load } = cardState;
  const via: Via = VIAS.includes(params.via as Via) ? (params.via as Via) : "code";
  const [result, setResult] = useState<Outcome | undefined>(
    isOutcome(params.outcome) ? params.outcome : undefined,
  );
  const [problem, setProblem] = useState<LocalizedText | null>(
    params.problemAr !== undefined && params.problemEn !== undefined
      ? { ar: params.problemAr, en: params.problemEn }
      : null,
  );
  const [welcome, setWelcome] = useState(welcomeOf(params.welcome));
  const [typed, setTyped] = useState<Typed>(() => heldAnswers(code) ?? {});
  const [pointed, setPointed] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const showOutcome = (outcome: JoinOutcome) => {
    if (outcome.kind === "joined") {
      setResult(joinedResult(outcome));
      setWelcome(outcome.welcome);
    } else if (outcome.kind === "stale") {
      setCard(outcome.card);
      setResult("stale");
      // The fields may have changed with it.
      void load();
    } else if (outcome.kind === "invalid_answers") {
      setPointed(outcome.field ?? undefined);
      setProblem(outcome.problem);
    } else if (outcome.kind === "refused" && outcome.code === "event_full") {
      // FR-1821: say it is full and offer the waiting list in place of Join.
      setResult("full");
    } else if (outcome.kind === "refused") {
      setProblem(outcome.problem);
    } else if (outcome.kind === "signed_out") {
      // The session ended meanwhile: sign in, and the join waits for it.
      router.push({ pathname: "/sign-in", params: { code, via, card: card?.version ?? "" } });
    } else {
      setResult("network");
    }
  };

  const tapJoin = async (waitlist: boolean) => {
    if (card === undefined || answer?.kind !== "card") {
      return;
    }
    const fields = answer.event.join.fields;
    const missing = firstMissing(fields, typed);
    setPointed(missing);
    if (missing !== undefined) {
      return;
    }
    const answers = answersFor(fields, typed);
    if (player.status !== "signed_in") {
      holdAnswers(code, answers);
      router.push({ pathname: "/sign-in", params: { code, via, card: card.version } });
      return;
    }
    setBusy(true);
    setProblem(null);
    showOutcome(
      await joinEvent(api.session, { code, via, cardVersion: card.version, answers }, waitlist),
    );
    setBusy(false);
  };

  return { result, problem, welcome, typed, setTyped, pointed, busy, tapJoin, player };
}

/** The join card by an event's join code. */
function JoinCardScreen() {
  const { t, language } = useI18n();
  const params = useLocalSearchParams<JoinParams>();
  const code = String(params.code).toUpperCase();
  const cardState = useCard(code);
  const { answer, card, load } = cardState;
  const flow = useJoinFlow(params, code, cardState);
  const { result, problem, welcome, typed, setTyped, pointed, busy, tapJoin, player } = flow;
  const joined =
    result === "active" || result === "pending" || result === "waitlisted" || result === "already";
  const explainer = useJoinExplainer(joined);

  if (answer === undefined) {
    return <Screen title={code}>{<AppText muted>{t("common.loading")}</AppText>}</Screen>;
  }
  if (answer.kind !== "card") {
    return (
      <Screen title={code}>
        <AppText>{t(OUTCOME_KEY[answer.kind])}</AppText>
        {answer.kind === "not_found" ? null : (
          <Button label={t("common.retry")} onPress={() => void load()} />
        )}
      </Screen>
    );
  }
  const { event } = answer;
  const ended = event.statusNow === "ended";
  return (
    <Screen title={textIn(event.name, language)}>
      <PushExplainer explainer={explainer} />
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        {textIn(event.venue, language) === "" ? null : (
          <AppText muted>{textIn(event.venue, language)}</AppText>
        )}
        {ended ? <AppText>{t("eventPage.ended")}</AppText> : null}
        <CardReceives card={card} />
        {joined && welcome > 0 ? <WelcomeReward points={welcome} /> : null}
        {ended || joined ? null : (
          <JoinForm rules={event.join} typed={typed} onType={setTyped} pointed={pointed} />
        )}
        {result === undefined ? null : <AppText>{t(OUTCOME_KEY[result])}</AppText>}
        <Problem problem={problem} />
        {joined ? (
          <Button
            label={t("joinCard.openEvent")}
            onPress={() => router.replace(`/event/${event.id}?joined=1`)}
          />
        ) : null}
        {ended || joined ? null : (
          <Button
            label={t(joinLabel(result === "full", event.access === "private"))}
            disabled={busy || card === undefined || player.status === "loading"}
            onPress={() => void tapJoin(result === "full")}
          />
        )}
      </ScrollView>
    </Screen>
  );
}
