import { type LocalizedText } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { completedText } from "#src/event/amount.ts";
import { ChoiceList } from "#src/event/ChoiceList.tsx";
import { useTerms } from "#src/event/EventContext.tsx";
import { castVote, fetchVote, type VoteView } from "#src/event/plays.ts";
import type { Quest } from "#src/event/quests-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";

/**
 * A vote quest in the quest sheet (FR-207): the organizer's options, one choice, one vote. A retry after a dropped
 * connection keeps the same key, so the vote is never counted twice.
 */
export function VoteEntry({ quest, onPaid }: Readonly<{ quest: Quest; onPaid: () => void }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const [view, setView] = useState<VoteView | undefined | "failed">(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<LocalizedText | null>(null);
  const [last, setLast] = useState<{ key: string; option: string } | undefined>(undefined);

  const load = useCallback(async () => {
    setView((await fetchVote(api.session, quest.id)) ?? "failed");
  }, [quest.id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (view === undefined) {
    return null;
  }
  if (view === "failed") {
    return (
      <>
        <AppText accessibilityRole="alert">{t("play.loadFailed")}</AppText>
        <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
      </>
    );
  }
  const mine = view.options.find((option) => option.id === view.mine);
  const vote = async (option: string) => {
    const key = last?.option === option ? last.key : randomUuid();
    setLast({ key, option });
    setBusy(true);
    setProblem(null);
    const answer = await castVote(api.session, quest.id, option, key);
    setBusy(false);
    if (answer.kind === "voted") {
      const paid = completedText(t, terms, language, answer.points);
      setSaid(`${t("play.vote.recorded")} ${paid}`);
      onPaid();
      await load();
      return;
    }
    if (answer.kind === "refused") {
      setProblem(answer.message);
    } else if (answer.kind === "network") {
      setSaid(t("join.network"));
    }
  };
  return (
    <>
      {said === null ? null : <AppText accessibilityRole="alert">{said}</AppText>}
      <Problem problem={problem} />
      {mine === undefined ? null : (
        <AppText variant="label">
          {t("play.vote.yours", { option: textIn(mine.text, language) })}
        </AppText>
      )}
      {mine === undefined && quest.state === "open" ? (
        <>
          <AppText variant="label">{t("play.vote.choose")}</AppText>
          <ChoiceList choices={view.options} chosen={chosen} disabled={busy} onChoose={setChosen} />
          <Button
            label={t("play.vote.send")}
            disabled={busy || chosen === null}
            onPress={() => chosen !== null && void vote(chosen)}
          />
        </>
      ) : null}
    </>
  );
}
