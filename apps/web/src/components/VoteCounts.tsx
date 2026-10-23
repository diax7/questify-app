"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import { voteCountsOf, type VoteCounts as Counts } from "#src/lib/votes.ts";
import styles from "#src/components/layout.module.css";

/** A vote quest's counts per option, for the team only (ADR-195); players never see them in T-302. */
export function VoteCounts({ language, url }: Readonly<{ language: Language; url: string }>) {
  const t = translatorFor(language);
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    let live = true;
    void requestJson("GET", url).then((result) => {
      if (live && result.ok) {
        setCounts(voteCountsOf(result.body) ?? null);
      }
    });
    return () => {
      live = false;
    };
  }, [url]);
  if (counts === null) {
    return null;
  }
  return (
    <section className={styles.field} aria-labelledby="vote-counts">
      <h3 id="vote-counts" className={styles.subtitle}>
        {t("quests.vote.results")}
      </h3>
      <ul className={styles.list}>
        {counts.options.map((option) => (
          <li key={option.id}>
            {t("quests.vote.count", {
              option: textFor(option.text, language),
              votes: formatNumber(option.votes, language),
            })}
          </li>
        ))}
      </ul>
      <p className={styles.muted}>
        {t("quests.vote.total", { total: formatNumber(counts.total, language) })}
      </p>
    </section>
  );
}
