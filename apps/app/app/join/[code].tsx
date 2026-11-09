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
  shownNotice,
  type CardAnswer,
  type JoinCard,
  type JoinOutcome,
} from "#src/join/join-api.ts";
import { CardReceives } from "#src/join/CardReceives.tsx";
import { cardParts, isJoinedResult, joinButton } from "#src/join/card-view.ts";
import { JoinForm } from "#src/join/JoinForm.tsx";
import {
  pointAtMissing,
  refusalAmong,
  refusalFromParams,
  refusalOf,
  type Pointed,
  type Refusal,
} from "#src/join/pointed.ts";
import { isInEvent, joinedResult, type JoinResult } from "#src/join/join-result.ts";
import { RehearsalJoin } from "#src/join/RehearsalJoin.tsx";
import { openJoinedEvent } from "#src/onboarding/open-joined.ts";
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
} as const satisfies Readonly<Record<JoinResult, MessageKey>>;

type Outcome = keyof typeof OUTCOME_KEY;

const isOutcome = (value: unknown): value is Outcome =>
  typeof value === "string" && value in OUTCOME_KEY;

const welcomeOf = (value: unknown): number => {
  const points = Number(value);
  return Number.isInteger(points) && points > 0 ? points : 0;
};

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

type JoinParams = Readonly<{
  code: string;
  via?: string;
  outcome?: string;
  problemAr?: string;
  problemEn?: string;
  /** The field a refusal after sign-in points at (its words then show under it). */
  problemField?: string;
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
  const [opening] = useState(() => refusalFromParams(params));
  const [problem, setProblem] = useState<LocalizedText | null>(opening.problem);
  const [welcome, setWelcome] = useState(welcomeOf(params.welcome));
  const [typed, setTyped] = useState<Typed>(() => heldAnswers(code) ?? {});
  const [pointed, setPointed] = useState<Pointed | undefined>(opening.pointed);
  const [busy, setBusy] = useState(false);

  const showRefusal = (outcome: Extract<JoinOutcome, { kind: "invalid_answers" | "refused" }>) => {
    if (outcome.kind === "invalid_answers") {
      const refusal = refusalOf(outcome);
      setPointed(refusal.pointed);
      setProblem(refusal.problem);
    } else if (outcome.code === "event_full") {
      // FR-1821: say it is full and offer the waiting list in place of Join.
      setResult("full");
    } else {
      setProblem(outcome.problem);
    }
  };

  const showOutcome = (outcome: JoinOutcome) => {
    if (outcome.kind === "joined") {
      setResult(joinedResult(outcome));
      setWelcome(outcome.welcome);
    } else if (outcome.kind === "stale") {
      setCard(outcome.card);
      setResult("stale");
      // The fields may have changed with it.
      void load();
    } else if (outcome.kind === "invalid_answers" || outcome.kind === "refused") {
      showRefusal(outcome);
    } else if (outcome.kind === "signed_out") {
      // The session ended meanwhile: sign in, and the join waits for it.
      router.push({ pathname: "/sign-in", params: { code, via, card: card?.version ?? "" } });
    } else {
      setResult("network");
    }
  };

  // A signed-out person signs in first; the answers wait in memory and the join goes through after sign-in.
  const signInFirst = (
    joinCard: JoinCard,
    answers: Record<string, string>,
    nameNotice: PendingJoin["nameNotice"],
  ) => {
    holdAnswers(code, answers);
    router.push({
      pathname: "/sign-in",
      params: { code, via, card: joinCard.version, notice: nameNotice },
    });
  };

  const sendJoin = async (rest: Omit<PendingJoin, "code" | "via">, waitlist: boolean) => {
    setBusy(true);
    setProblem(null);
    showOutcome(await joinEvent(api.session, { code, via, ...rest }, waitlist));
    setBusy(false);
  };

  const tapJoin = async (waitlist: boolean) => {
    if (card === undefined || answer?.kind !== "card") {
      return;
    }
    const fields = answer.event.join.fields;
    const missing = firstMissing(fields, typed);
    setPointed(pointAtMissing(missing));
    if (missing !== undefined) {
      return;
    }
    const answers = answersFor(fields, typed);
    const nameNotice = shownNotice(card);
    if (player.status !== "signed_in") {
      signInFirst(card, answers, nameNotice);
      return;
    }
    await sendJoin({ cardVersion: card.version, nameNotice, answers }, waitlist);
  };

  return { result, problem, welcome, typed, setTyped, pointed, busy, tapJoin, player };
}

type CardEvent = Extract<CardAnswer, { kind: "card" }>["event"];
type Flow = ReturnType<typeof useJoinFlow>;

/** The event's venue and end note, what the card gives, the welcome reward, the join form, the outcome and the problem. */
function CardBody({
  event,
  card,
  flow,
  shown,
  ended,
  parts,
}: Readonly<{
  event: CardEvent;
  card: JoinCard | undefined;
  flow: Flow;
  shown: Refusal;
  ended: boolean;
  parts: ReturnType<typeof cardParts>;
}>) {
  const { t, language } = useI18n();
  const { result, welcome, typed, setTyped } = flow;
  const venue = textIn(event.venue, language);
  return (
    <>
      {venue === "" ? null : <AppText muted>{venue}</AppText>}
      {ended ? <AppText>{t("eventPage.ended")}</AppText> : null}
      <CardReceives card={card} />
      {parts.welcome ? <WelcomeReward points={welcome} /> : null}
      {parts.join ? (
        <JoinForm rules={event.join} typed={typed} onType={setTyped} pointed={shown.pointed} />
      ) : null}
      {result === undefined ? null : <AppText>{t(OUTCOME_KEY[result])}</AppText>}
      <Problem problem={shown.problem} />
    </>
  );
}

/** Open the event once joined, else the Join button (the waiting list when full). */
function CardButtons({
  event,
  card,
  flow,
  joined,
  parts,
}: Readonly<{
  event: CardEvent;
  card: JoinCard | undefined;
  flow: Flow;
  joined: boolean;
  parts: ReturnType<typeof cardParts>;
}>) {
  const { t, language } = useI18n();
  const { result, busy, tapJoin, player } = flow;
  const button = joinButton({
    result,
    isPrivate: event.access === "private",
    busy,
    cardMissing: card === undefined,
    playerLoading: player.status === "loading",
  });
  return (
    <>
      {joined ? (
        <Button
          label={t("joinCard.openEvent")}
          onPress={() =>
            void openJoinedEvent(event.id, textIn(event.name, language), isInEvent(result))
          }
        />
      ) : null}
      {parts.join ? (
        <Button
          label={t(button.label)}
          disabled={button.disabled}
          onPress={() => void tapJoin(button.waitlist)}
        />
      ) : null}
    </>
  );
}

/** The join card by an event's join code. */
function JoinCardScreen() {
  const { t, language } = useI18n();
  const params = useLocalSearchParams<JoinParams>();
  const code = String(params.code).toUpperCase();
  const cardState = useCard(code);
  const { answer, card, load } = cardState;
  const flow = useJoinFlow(params, code, cardState);
  const { result, problem, welcome, pointed } = flow;
  const joined = isJoinedResult(result);
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
  const shown = refusalAmong(
    { pointed, problem },
    event.join.fields.map((field) => field.id),
  );
  const parts = cardParts(joined, ended, welcome);
  return (
    <Screen title={textIn(event.name, language)}>
      <PushExplainer explainer={explainer} />
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        <CardBody event={event} card={card} flow={flow} shown={shown} ended={ended} parts={parts} />
        <CardButtons event={event} card={card} flow={flow} joined={joined} parts={parts} />
      </ScrollView>
    </Screen>
  );
}
