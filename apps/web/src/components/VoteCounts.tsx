"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import { shareOf, voteCountsOf, type VoteCounts as Counts } from "#src/lib/votes.ts";
import { Muted } from "#src/ui/Feedback.tsx";
import { Card, CardList, SubHeading } from "#src/ui/Section.tsx";

/**
 * A vote quest's counts per option with each one's share of the voters, for the team only (ADR-195). `refreshMs`
 * reads them again on that beat (an open live poll on the quest list, T-306).
 */
export function VoteCounts({
  language,
  url,
  refreshMs,
}: Readonly<{ language: Language; url: string; refreshMs?: number }>) {
  const t = translatorFor(language);
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void requestJson("GET", url).then((result) => {
        if (live && result.ok) {
          setCounts(voteCountsOf(result.body) ?? null);
        }
      });
    read();
    const timer = refreshMs === undefined ? undefined : setInterval(read, refreshMs);
    return () => {
      live = false;
      if (timer !== undefined) {
        clearInterval(timer);
      }
    };
  }, [url, refreshMs]);
  if (counts === null) {
    return null;
  }
  return (
    <Card as="section" aria-label={t("quests.vote.results")}>
      <SubHeading as="h3">{t("quests.vote.results")}</SubHeading>
      <CardList>
        {counts.options.map((option) => (
          <li key={option.id}>
            {t("quests.vote.share", {
              option: textFor(option.text, language),
              votes: formatNumber(option.votes, language),
              percent: formatNumber(shareOf(option.votes, counts.voters), language),
            })}
          </li>
        ))}
      </CardList>
      <Muted>{t("quests.vote.voters", { count: formatNumber(counts.voters, language) })}</Muted>
      {counts.total > counts.voters ? <Muted>{t("quests.vote.sharesNote")}</Muted> : null}
    </Card>
  );
}
