import { formatEventTime, formatNumber } from "@questify/shared";
import { router, useSegments } from "expo-router";
import { useEffect, useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import { keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { useOpenSheets } from "#src/components/sheet-count.ts";
import { communityNews, type CommunityCard, type CommunityNews } from "#src/event/community.ts";
import { Button } from "#src/components/Controls.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { nextDrop, type LiveBoost, type LiveFlash } from "#src/event/flash-boost.ts";
import { useLive } from "#src/event/LiveContext.tsx";
import { PollEntry } from "#src/event/PollEntry.tsx";
import {
  calmScreen,
  nextPoll,
  nextResults,
  rememberShown,
  resultsShownKey,
  shownOf,
} from "#src/event/polls.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";

type Card =
  | Readonly<{ kind: "poll" | "results"; questId: string }>
  | Readonly<{ kind: "community"; news: CommunityNews; goal: CommunityCard }>
  | Readonly<{ kind: "flash"; flash: LiveFlash }>
  | Readonly<{ kind: "boost"; boost: LiveBoost }>;

/** The results and community cards this phone already showed for the event (one-time each), read once. */
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

/** The one-time card's title: the points paid, a reached moment, or something unlocked (T-306c). */
const NEWS_TITLE = {
  paid: "community.paidTitle",
  moment: "community.momentTitle",
  unlocked: "community.unlockedTitle",
} as const;

/** What a reached unlock opened: its name when the player sees it, else "Something new is unlocked". */
function unlockedText(
  news: CommunityNews,
  t: ReturnType<typeof useI18n>["t"],
  language: "ar" | "en",
): string {
  const target = news.step.reward.target;
  return target === undefined
    ? t("community.unlockedSurprise")
    : t("community.unlocked", { name: textIn(target.name, language) });
}

/**
 * A one-time community card (T-306b, FR-247): a reached moment step, the points a step paid the player, or what a
 * reached step unlocked (T-306c).
 */
function CommunityNewsBody({ news, goal }: Readonly<{ news: CommunityNews; goal: CommunityCard }>) {
  const { t, language } = useI18n();
  const moment = news.step.reward.moment;
  return (
    <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
      <AppText variant="label" muted>
        {textIn(goal.title, language)}
      </AppText>
      <AppText variant="title">
        {news.kind === "paid"
          ? t("community.paid", { points: formatNumber(news.step.reward.points ?? 0, language) })
          : news.kind === "unlocked"
            ? unlockedText(news, t, language)
            : moment === undefined
              ? t("community.reached")
              : textIn(moment, language)}
      </AppText>
    </View>
  );
}

/**
 * A one-time flash quest or boost card (T-307): "Flash quest!" with its title, its end and Open (the quest on the
 * Quests tab), or "Double points" with the category and its end. Times in the event's zone.
 */
function DropBody({ card, close }: Readonly<{ card: Card; close: () => void }>) {
  const { t, language } = useI18n();
  const { eventId, events } = useEvent();
  const timeZone = events?.find((event) => event.id === eventId)?.timezone ?? "Asia/Riyadh";
  if (card.kind === "flash") {
    const open = () => {
      close();
      router.navigate({
        pathname: "/event/[eventId]/quests",
        params: { eventId, quest: card.flash.questId },
      });
    };
    return (
      <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
        <AppText variant="title">{textIn(card.flash.title, language)}</AppText>
        <AppText muted>
          {t("quests.flash.endsAt", {
            time: formatEventTime(new Date(card.flash.closesAt), timeZone, language),
          })}
        </AppText>
        <Button label={t("live.flash.open")} onPress={open} />
      </View>
    );
  }
  if (card.kind !== "boost") {
    return null;
  }
  return (
    <AppText variant="title" accessibilityLiveRegion="polite">
      {t("live.boost.body", {
        category: textIn(card.boost.category, language),
        time: formatEventTime(new Date(card.boost.endsAt), timeZone, language),
      })}
    </AppText>
  );
}

/**
 * The live poll pop-up (FR-239): a sheet over the event's tabs for an open poll the player has not voted in or put off
 * in this session, a one-time card when an at_close poll's results are in, and one per community step that reached a
 * moment or paid the player (T-306b). It waits for a calm screen: never over a mini-game, a quiz or any other sheet,
 * or the camera (those are their own screens or sheets).
 */
export function LivePolls() {
  const { t } = useI18n();
  const { eventId, notePaid } = useEvent();
  const live = useLive();
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
      return;
    }
    const news = shown === undefined ? undefined : communityNews(live.community, shown)[0];
    if (news !== undefined && live.community !== null) {
      remember(news.key);
      setCard({ kind: "community", news, goal: live.community });
      if (news.kind === "paid") {
        notePaid();
      }
      AccessibilityInfo.announceForAccessibility(t(NEWS_TITLE[news.kind]));
      return;
    }
    // A new flash quest or boost: the quest list and Home read again for its badge, then its one-time card.
    const drop = shown === undefined ? undefined : nextDrop(live, shown);
    if (drop !== undefined) {
      remember(drop.key);
      notePaid();
      setCard(drop.kind === "flash" ? { kind: "flash", flash: drop.flash } : drop);
      AccessibilityInfo.announceForAccessibility(
        t(drop.kind === "flash" ? "live.flash.title" : "live.boost.title"),
      );
    }
  }, [card, calm, live, putOff, shown, remember, t, notePaid]);

  if (card === null) {
    return null;
  }
  if (card.kind === "flash" || card.kind === "boost") {
    const close = () => setCard(null);
    return (
      <Sheet
        visible
        title={t(card.kind === "flash" ? "live.flash.title" : "live.boost.title")}
        onClose={close}
      >
        <DropBody card={card} close={close} />
      </Sheet>
    );
  }
  if (card.kind === "community") {
    return (
      <Sheet visible title={t(NEWS_TITLE[card.news.kind])} onClose={() => setCard(null)}>
        <CommunityNewsBody news={card.news} goal={card.goal} />
      </Sheet>
    );
  }
  const questId = card.questId;
  const close = () => {
    setPutOff((current) => new Set([...current, questId]));
    setCard(null);
  };
  return (
    <Sheet
      visible
      title={t(card.kind === "poll" ? "poll.live" : "poll.resultsIn")}
      onClose={close}
      closeLabel={card.kind === "poll" ? t("poll.later") : undefined}
    >
      <PollEntry key={questId} questId={questId} onPaid={notePaid} card />
    </Sheet>
  );
}
