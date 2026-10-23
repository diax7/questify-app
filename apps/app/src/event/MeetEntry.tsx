import { formatNumber, type Theme } from "@questify/shared";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { QrCode } from "#src/components/QrCode.tsx";
import { completedText } from "#src/event/amount.ts";
import { useEvent, useTerms } from "#src/event/EventContext.tsx";
import {
  MEET_POLL,
  meetRefusalText,
  nextPoll,
  readPassState,
  showMeetPass,
  type PassAnswer,
} from "#src/event/meet.ts";
import type { Quest } from "#src/event/quests-api.ts";
import { outcomeText } from "#src/event/QuestSheet.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Shown = Extract<PassAnswer, { kind: "pass" }>;

/**
 * The shown code (ADR-209): drawn while its minute lasts, with a bar that empties; its state is read every 2 seconds
 * (5 after a 429) and never past its minute. An expired code is replaced at once while the screen stays open; a used
 * one ends with "You met @name".
 */
function ShownCode({
  quest,
  onMet,
  onStop,
}: Readonly<{
  quest: Quest;
  onMet: (text: string) => void;
  onStop: (text: string | null) => void;
}>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const [shown, setShown] = useState<Shown | undefined>(undefined);
  const [now, setNow] = useState(Date.now());
  const live = useRef(true);

  const fresh = useCallback(async () => {
    const answer = await showMeetPass(api.session, quest.id);
    if (!live.current) {
      return;
    }
    if (answer.kind === "pass") {
      setShown(answer);
      return;
    }
    onStop(
      answer.kind === "meet_refused"
        ? meetRefusalText(answer, t)
        : (outcomeText(answer, t, language, terms) ?? t("meet.failed")),
    );
  }, [quest.id, onStop, t, language, terms]);

  useEffect(() => {
    live.current = true;
    void fresh();
    return () => {
      live.current = false;
    };
  }, [fresh]);

  useEffect(() => {
    const ticking = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ticking);
  }, []);

  useEffect(() => {
    if (shown === undefined) {
      return undefined;
    }
    const shownAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (wait: number) => {
      timer = setTimeout(async () => {
        const state = await readPassState(api.session, shown.passId);
        if (!live.current) {
          return;
        }
        if (state.state === "used") {
          onMet(
            `${t("meet.youMet", { name: state.username })} · ${completedText(t, terms, language, state.points)}`,
          );
          return;
        }
        const next = nextPoll(state, shownAt, Date.now());
        if (next === null) {
          void fresh();
          return;
        }
        void poll(next);
      }, wait);
    };
    void poll(MEET_POLL.everyMs);
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [shown, fresh, onMet, t, terms, language]);

  if (shown === undefined) {
    return <AppText muted>{t("common.loading")}</AppText>;
  }
  const left = Math.max(0, Date.parse(shown.expiresAt) - now);
  const share = Math.min(1, left / MEET_POLL.codeMs);
  return (
    <View style={styles.code}>
      <AppText variant="title">{t("meet.codeTitle")}</AppText>
      <QrCode text={shown.code} size={Math.min(width - 64, 320)} label={t("meet.codeTitle")} />
      <View style={styles.track} accessibilityRole="progressbar">
        <View style={[styles.bar, { width: `${Math.round(share * 100)}%` }]} />
      </View>
      <AppText muted>{t("meet.codeHelp")}</AppText>
      <Button kind="quiet" label={t("common.close")} onPress={() => onStop(null)} />
    </View>
  );
}

/**
 * A meet quest in the quest sheet (FR-212, FR-213): how many people the player met of the quest's cap and today's,
 * "Show my code" (a one-minute code the other player scans) and "Scan their code" (the scanner).
 */
export function MeetEntry({ quest, onPaid }: Readonly<{ quest: Quest; onPaid: () => void }>) {
  const { t, language } = useI18n();
  const { eventId } = useEvent();
  const [showing, setShowing] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const met = useCallback(
    (text: string) => {
      setShowing(false);
      setSaid(text);
      onPaid();
    },
    [onPaid],
  );
  const stop = useCallback((text: string | null) => {
    setShowing(false);
    setSaid(text);
  }, []);
  const number = (value: number) => formatNumber(value, language);
  return (
    <>
      <AppText>
        {t("meet.progress", { done: number(quest.done), cap: number(quest.repeatCap) })}
      </AppText>
      {quest.meet === null ? null : (
        <AppText muted>
          {t("meet.today", { count: number(quest.meet.today), cap: number(quest.meet.dailyCap) })}
        </AppText>
      )}
      {said === null ? null : <AppText accessibilityRole="alert">{said}</AppText>}
      {showing ? <ShownCode quest={quest} onMet={met} onStop={stop} /> : null}
      {quest.state === "open" && !showing ? (
        <>
          <Button
            label={t("meet.show")}
            onPress={() => {
              setSaid(null);
              setShowing(true);
            }}
          />
          <Button
            kind="quiet"
            label={t("meet.scan")}
            onPress={() =>
              router.push({
                pathname: "/event/[eventId]/scan-quest",
                params: { eventId, quest: quest.id },
              })
            }
          />
        </>
      ) : null}
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  code: { gap: theme.spacing.md, alignItems: "center" as const },
  track: {
    width: "100%" as const,
    height: 6,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.border,
    overflow: "hidden" as const,
  },
  bar: { height: 6, backgroundColor: theme.colors.primaryAction },
});
