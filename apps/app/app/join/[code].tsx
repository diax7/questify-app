import type { LocalizedText, MessageKey } from "@questify/shared";
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
import {
  fetchCard,
  joinEvent,
  type CardAnswer,
  type JoinCard,
  type JoinOutcome,
} from "#src/join/join-api.ts";

type Via = PendingJoin["via"];

const VIAS: readonly Via[] = ["code", "qr", "link", "public_list"];

/** What the screen says for each state and outcome (the API's own message for its refusals). */
const OUTCOME_KEY = {
  active: "join.active",
  pending: "join.pending",
  already: "join.already",
  network: "join.network",
  not_found: "join.notFound",
  throttled: "join.throttled",
  stale: "join.stale",
} as const satisfies Readonly<Record<string, MessageKey>>;

type Outcome = keyof typeof OUTCOME_KEY;

const isOutcome = (value: unknown): value is Outcome =>
  typeof value === "string" && value in OUTCOME_KEY;

const textIn = (text: Readonly<{ ar: string | null; en: string | null }>, language: "ar" | "en") =>
  text[language] ?? text[language === "ar" ? "en" : "ar"] ?? "";

/**
 * The join card (FR-121, FR-111, FR-112): the event, what the organizer will see, one Join button. Anyone can read it;
 * Join asks a signed-out person to sign in first, and the join goes through only after that succeeds.
 */
export default function JoinScreen() {
  const { t, language } = useI18n();
  const { state: player } = usePlayer();
  const params = useLocalSearchParams<{
    code: string;
    via?: string;
    outcome?: string;
    problemAr?: string;
    problemEn?: string;
  }>();
  const code = String(params.code).toUpperCase();
  const via: Via = VIAS.includes(params.via as Via) ? (params.via as Via) : "code";
  const [answer, setAnswer] = useState<CardAnswer | undefined>(undefined);
  const [card, setCard] = useState<JoinCard | undefined>(undefined);
  const [result, setResult] = useState<Outcome | undefined>(
    isOutcome(params.outcome) ? params.outcome : undefined,
  );
  const [problem, setProblem] = useState<LocalizedText | null>(
    params.problemAr !== undefined && params.problemEn !== undefined
      ? { ar: params.problemAr, en: params.problemEn }
      : null,
  );
  const [busy, setBusy] = useState(false);

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

  const showOutcome = (outcome: JoinOutcome) => {
    if (outcome.kind === "joined") {
      setResult(outcome.alreadyMember ? "already" : outcome.status);
    } else if (outcome.kind === "stale") {
      setCard(outcome.card);
      setResult("stale");
    } else if (outcome.kind === "refused") {
      setProblem(outcome.problem);
    } else if (outcome.kind === "signed_out") {
      // The session ended meanwhile: sign in, and the join waits for it.
      router.push({ pathname: "/sign-in", params: { code, via, card: card?.version ?? "" } });
    } else {
      setResult("network");
    }
  };

  const tapJoin = async () => {
    if (card === undefined) {
      return;
    }
    if (player.status !== "signed_in") {
      router.push({ pathname: "/sign-in", params: { code, via, card: card.version } });
      return;
    }
    setBusy(true);
    setProblem(null);
    showOutcome(await joinEvent(api.session, { code, via, cardVersion: card.version }));
    setBusy(false);
  };

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
  const joined = result === "active" || result === "pending" || result === "already";
  return (
    <Screen title={textIn(event.name, language)}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        {textIn(event.venue, language) === "" ? null : (
          <AppText muted>{textIn(event.venue, language)}</AppText>
        )}
        {ended ? <AppText>{t("eventPage.ended")}</AppText> : null}
        {card === undefined ? null : (
          <>
            <AppText variant="title">{card.title[language]}</AppText>
            {card.receives.map((item) => (
              <AppText key={item.en}>• {item[language]}</AppText>
            ))}
          </>
        )}
        {result === undefined ? null : <AppText>{t(OUTCOME_KEY[result])}</AppText>}
        <Problem problem={problem} />
        {ended || joined ? null : (
          <Button
            label={t("joinCard.join")}
            disabled={busy || card === undefined || player.status === "loading"}
            onPress={() => void tapJoin()}
          />
        )}
      </ScrollView>
    </Screen>
  );
}
