import { formatNumber, type LocalizedText, type Theme } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { Amount } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { paidText } from "#src/event/amount.ts";
import { ChoiceList } from "#src/event/ChoiceList.tsx";
import { useTerms } from "#src/event/EventContext.tsx";
import { castVote, secondsLeft } from "#src/event/plays.ts";
import { clockText, fetchPoll, sharesOf, toggleChoice, type PollView } from "#src/event/polls.ts";
import { streakBonusLine } from "#src/streaks/event-streak.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Clock = Readonly<{ serverNow: string; receivedAt: number }>;

/** The seconds left on the poll by the server's clock, ticking once a second while it is open. */
function useSecondsLeft(closesAt: string | undefined, clock: Clock): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (closesAt === undefined) {
      return undefined;
    }
    const tick = () => setLeft(secondsLeft(closesAt, clock, Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [closesAt, clock]);
  return left;
}

/** A poll's counts as bars of the voters' shares, the player's own choices marked; never who voted (FR-242). */
export function PollResults({ view }: Readonly<{ view: PollView }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (view.counts === null) {
    return null;
  }
  const shares = sharesOf(view.counts);
  return (
    <View style={styles.results}>
      {view.options.map((option) => {
        const percent = shares.find((share) => share.id === option.id)?.percent ?? 0;
        const name = textIn(option.text, language);
        const label = view.mine.includes(option.id) ? t("poll.yourChoice", { option: name }) : name;
        return (
          <View key={option.id} style={styles.row}>
            <AppText variant="label">
              {t("poll.share", { option: label, percent: formatNumber(percent, language) })}
            </AppText>
            <View style={styles.track}>
              <View style={[styles.bar, { width: `${Math.min(100, percent)}%` }]} />
            </View>
          </View>
        );
      })}
      <AppText muted>
        {t("poll.voters", { count: formatNumber(view.counts.voters, language) })}
      </AppText>
    </View>
  );
}

/** What the player sees once they voted, or once the poll closed: the counts, or when they will show. */
function AfterVote({ view }: Readonly<{ view: PollView }>) {
  const { t } = useI18n();
  if (view.counts !== null) {
    return <PollResults view={view} />;
  }
  if (view.results === "at_close" && !view.closed) {
    return <AppText>{t("poll.resultsAtClose")}</AppText>;
  }
  return view.results === "never" ? <AppText muted>{t("poll.resultsNever")}</AppText> : null;
}

/** What the sheet shows for a read: the poll, a switch the organizer turned off, or a failure (a plain vote too). */
const pollState = (
  read: PollView | "not_live" | "off" | undefined,
): PollView | "off" | "failed" => {
  if (read === "off") return "off";
  return read === undefined || read === "not_live" ? "failed" : read;
};

/** A poll that could not be read (with a retry), or one the organizer switched off (T-602c). */
function PollUnavailable({ off, retry }: Readonly<{ off: boolean; retry: () => void }>) {
  const { t } = useI18n();
  if (off) return <AppText accessibilityRole="alert">{t("play.pollsOff")}</AppText>;
  return (
    <>
      <AppText accessibilityRole="alert">{t("play.loadFailed")}</AppText>
      <Button kind="quiet" label={t("common.retry")} onPress={retry} />
    </>
  );
}

/**
 * A live poll (FR-239 to FR-242): its options as one choice or several, a countdown on the server's clock, Vote, and
 * after it the results its policy allows. The same component in the quest sheet and in the live pop-up card. A retry
 * after a dropped connection keeps the same key for the same choices, so the vote is never counted twice.
 */
export function PollEntry({
  questId,
  onPaid,
  onVoted = () => undefined,
  card = false,
}: Readonly<{
  questId: string;
  onPaid: () => void;
  onVoted?: () => void;
  /** In the pop-up card, which has no quest title or points of its own above it. */
  card?: boolean;
}>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const [view, setView] = useState<PollView | undefined | "failed" | "off">(undefined);
  const [clock, setClock] = useState<Clock>({ serverNow: new Date().toISOString(), receivedAt: 0 });
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [last, setLast] = useState<{ key: string; options: string } | undefined>(undefined);

  const load = useCallback(async () => {
    const read = pollState(await fetchPoll(api.session, questId));
    if (typeof read === "object") setClock({ serverNow: read.serverNow, receivedAt: Date.now() });
    setView(read);
  }, [questId]);
  useEffect(() => {
    void load();
  }, [load]);
  const left = useSecondsLeft(typeof view === "object" ? view.closesAt : undefined, clock);

  if (view === undefined) {
    return null;
  }
  if (typeof view === "string") {
    return <PollUnavailable off={view === "off"} retry={() => void load()} />;
  }
  const vote = async () => {
    const options = [...chosen].sort().join(",");
    const key = last?.options === options ? last.key : randomUuid();
    setLast({ key, options });
    setBusy(true);
    setProblem(null);
    const answer = await castVote(api.session, questId, chosen, key);
    setBusy(false);
    if (answer.kind === "voted") {
      // A 0-point poll can still pay a streak bonus (T-405b): its line shows on its own.
      const paid =
        answer.points > 0
          ? paidText(t, terms, language, answer)
          : answer.streakBonus === null
            ? null
            : streakBonusLine(t, answer.streakBonus);
      setSaid(paid === null ? t("poll.thanks") : `${t("poll.thanks")} ${paid}`);
      onPaid();
      onVoted();
      await load();
      return;
    }
    if (answer.kind === "refused") {
      setProblem(answer.message);
    } else if (answer.kind === "network") {
      setSaid(t("join.network"));
    }
  };
  const closed = view.closed || left === 0;
  const voting = view.mine.length === 0 && !closed;
  return (
    <>
      {card ? (
        <>
          <AppText variant="label">{textIn(view.title, language)}</AppText>
          {view.points > 0 ? (
            <Amount amount={formatNumber(view.points, language)} form="labelled" variant="label" />
          ) : null}
        </>
      ) : (
        <AppText muted>{t("poll.live")}</AppText>
      )}
      {said === null ? null : <AppText accessibilityRole="alert">{said}</AppText>}
      <Problem problem={problem} />
      {closed ? (
        <AppText variant="label">{t("poll.closed")}</AppText>
      ) : left === null ? null : (
        <AppText muted>{t("poll.closesIn", { time: clockText(left) })}</AppText>
      )}
      {voting ? (
        <>
          <AppText variant="label">
            {t(view.choices === "several" ? "poll.pickSeveral" : "poll.pickOne")}
          </AppText>
          <ChoiceList
            choices={view.options}
            chosen={chosen[0] ?? null}
            multiple={view.choices === "several"}
            selected={chosen}
            disabled={busy}
            onChoose={(id) => setChosen((current) => toggleChoice(current, id, view.choices))}
          />
          <Button
            label={t("play.vote.send")}
            disabled={busy || chosen.length === 0}
            onPress={() => void vote()}
          />
        </>
      ) : (
        <AfterVote view={view} />
      )}
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  results: { gap: theme.spacing.sm },
  row: { gap: theme.spacing.xs },
  track: {
    height: theme.spacing.sm,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.border,
    overflow: "hidden" as const,
  },
  bar: { height: "100%" as const, backgroundColor: theme.colors.primaryAction },
});
