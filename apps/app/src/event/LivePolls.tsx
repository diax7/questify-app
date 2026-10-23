import { useSegments } from "expo-router";
import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { keyValueStore } from "#src/api/app-session.ts";
import { Sheet } from "#src/components/Sheet.tsx";
import { useOpenSheets } from "#src/components/sheet-count.ts";
import { useEvent } from "#src/event/EventContext.tsx";
import { PollEntry } from "#src/event/PollEntry.tsx";
import {
  calmScreen,
  nextPoll,
  nextResults,
  rememberShown,
  resultsShownKey,
  shownOf,
} from "#src/event/polls.ts";
import { useLiveState } from "#src/event/useLive.ts";
import { useI18n } from "#src/i18n/provider.tsx";

type Card = Readonly<{ kind: "poll" | "results"; questId: string }>;

/** The results cards this phone already showed for the event (one-time each), read once. */
function useShownResults(eventId: string) {
  const [shown, setShown] = useState<readonly string[] | undefined>(undefined);
  useEffect(() => {
    let current = true;
    setShown(undefined);
    void keyValueStore
      .getItem(resultsShownKey(eventId))
      .then((raw) => current && setShown(shownOf(raw)))
      .catch(() => current && setShown([]));
    return () => {
      current = false;
    };
  }, [eventId]);
  const remember = (questId: string) => {
    const next = rememberShown(shown ?? [], questId);
    setShown(next);
    void keyValueStore
      .setItem(resultsShownKey(eventId), JSON.stringify(next))
      .catch(() => undefined);
  };
  return { shown, remember };
}

/**
 * The live poll pop-up (FR-239): a sheet over the event's tabs for an open poll the player has not voted in or put off
 * in this session, and a one-time card when an at_close poll's results are in. It waits for a calm screen: never over
 * a mini-game, a quiz or any other sheet, or the camera (those are their own screens or sheets).
 */
export function LivePolls() {
  const { t } = useI18n();
  const { eventId, livePollSeconds } = useEvent();
  const live = useLiveState(eventId, livePollSeconds);
  const segments = useSegments();
  const sheets = useOpenSheets();
  const { shown, remember } = useShownResults(eventId);
  const [putOff, setPutOff] = useState<ReadonlySet<string>>(new Set());
  const [card, setCard] = useState<Card | null>(null);
  const calm = calmScreen(segments, sheets);

  useEffect(() => {
    if (card !== null || !calm) {
      return;
    }
    const poll = nextPoll(live, putOff);
    if (poll !== undefined) {
      setCard({ kind: "poll", questId: poll.questId });
      AccessibilityInfo.announceForAccessibility(t("poll.live"));
      return;
    }
    const results = shown === undefined ? undefined : nextResults(live, shown);
    if (results !== undefined) {
      remember(results);
      setCard({ kind: "results", questId: results });
      AccessibilityInfo.announceForAccessibility(t("poll.resultsIn"));
    }
  }, [card, calm, live, putOff, shown, remember, t]);

  if (card === null) {
    return null;
  }
  const close = () => {
    setPutOff((current) => new Set([...current, card.questId]));
    setCard(null);
  };
  return (
    <Sheet
      visible
      title={t(card.kind === "poll" ? "poll.live" : "poll.resultsIn")}
      onClose={close}
      closeLabel={card.kind === "poll" ? t("poll.later") : undefined}
    >
      <PollEntry key={card.questId} questId={card.questId} onPaid={() => undefined} card />
    </Sheet>
  );
}
