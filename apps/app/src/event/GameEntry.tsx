import { GAME_NAME_KEYS, targetWords } from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import {
  actionLine,
  attemptsLine,
  levelLine,
  resendable,
  resultLine,
} from "#src/event/game-words.ts";
import {
  fetchGameSheet,
  games,
  sendGameResult,
  sheetAction,
  startGameRound,
  type GameSheet,
  type PendingResult,
  type RoundAnswer,
} from "#src/event/games.ts";
import type { Quest } from "#src/event/quests-api.ts";
import { outcomeText } from "#src/event/QuestSheet.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** The words for a round that was not issued: an update first, the game's own refusal, or the sheet's refusal. */
function refusalLine(
  answer: Exclude<RoundAnswer, { kind: "round" }>,
  t: ReturnType<typeof useI18n>["t"],
  language: "ar" | "en",
  terms: ReturnType<typeof useTerms>,
): string {
  if (answer.kind === "update") {
    return t("play.game.update");
  }
  if (answer.kind === "game_refused") {
    return t(answer.reason === "attempts_used" ? "play.game.noAttempts" : "play.game.expired");
  }
  return outcomeText(answer, t, language, terms) ?? t("questsTab.failed");
}

/**
 * A game quest in the quest sheet (T-305, FR-1806, FR-1807, FR-1809): the game, its level and target, the attempts, and
 * Play; "Passed", "Already played", "No attempts left" or the next try's time instead. While a finished round's result
 * waits to be sent, Retry replaces Play (CTO 6), until its window ends.
 */
export function GameEntry({
  quest,
  timeZone,
  onPaid,
}: Readonly<{ quest: Quest; timeZone: string; onPaid: () => void }>) {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const terms = useTerms();
  const [sheet, setSheet] = useState<GameSheet | "update" | undefined | "failed">(undefined);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A Play whose answer was lost is sent again with the same key, so it never uses a second attempt.
  const lostKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    const read = await fetchGameSheet(api.session, quest.id);
    setSheet(read ?? "failed");
  }, [quest.id]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const play = async () => {
    const key = lostKey.current ?? randomUuid();
    setBusy(true);
    setSaid(null);
    const answer = await startGameRound(api.session, quest.id, key);
    setBusy(false);
    lostKey.current = answer.kind === "network" ? key : null;
    if (answer.kind === "round") {
      games.keepRound(answer.round);
      router.push({
        pathname: "/event/[eventId]/game",
        params: { eventId, roundId: answer.round.roundId },
      });
      return;
    }
    setSaid(refusalLine(answer, t, language, terms));
    void load();
  };
  const retry = async (pending: PendingResult) => {
    setBusy(true);
    const answer = await sendGameResult(api.session, pending);
    setBusy(false);
    if (!resendable(answer)) {
      games.dropResult(pending.questId);
    }
    setSaid(resultLine(t, answer, terms, language));
    if (answer.kind === "passed") {
      onPaid();
    }
    void load();
  };

  if (sheet === undefined) {
    return <AppText muted>{t("common.loading")}</AppText>;
  }
  if (sheet === "failed") {
    return <AppText>{t("questsTab.failed")}</AppText>;
  }
  if (sheet === "update") {
    return <AppText accessibilityRole="alert">{t("play.game.update")}</AppText>;
  }
  const action = sheetAction(sheet, games.result(quest.id, Date.now()), Date.now());
  const why = actionLine(t, action, language, timeZone);
  return (
    <>
      <AppText variant="label">{t(GAME_NAME_KEYS[sheet.game])}</AppText>
      <AppText muted>{levelLine(t, sheet.level)}</AppText>
      <AppText>{targetWords(t, sheet.target, language)}</AppText>
      <AppText muted>{attemptsLine(t, sheet, language)}</AppText>
      {said === null ? null : <AppText accessibilityRole="alert">{said}</AppText>}
      {why === null ? null : <AppText variant="label">{why}</AppText>}
      {action.kind === "retry" ? (
        <>
          <AppText accessibilityRole="alert">{t("play.game.unsent")}</AppText>
          <Button
            label={t("play.game.resend")}
            disabled={busy}
            onPress={() => void retry(action.pending)}
          />
        </>
      ) : null}
      {action.kind === "play" && quest.state === "open" ? (
        <Button label={t("play.game.play")} disabled={busy} onPress={() => void play()} />
      ) : null}
    </>
  );
}
