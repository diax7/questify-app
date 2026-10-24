"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { named } from "#src/lib/prizes.ts";
import { questItemsOf, ranOut, type QuestItem } from "#src/lib/quest-items.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/**
 * The event overview's warning (FR-1617, T-304d): each quest item that ran out while a quest or category still gives it,
 * with how many players got points only, linking to the Prizes page. Nothing while all is well or the read fails.
 */
export function QuestItemWarnings({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const [out, setOut] = useState<readonly QuestItem[]>([]);
  useEffect(() => {
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}/quest-items`).then(
      (result) => setOut(ranOut((result.ok ? questItemsOf(result.body) : undefined) ?? [])),
    );
  }, [organizerId, eventId]);
  if (out.length === 0) {
    return null;
  }
  return (
    <div role="alert" className={styles.alert}>
      {out.map((item) => (
        <p key={item.id} dir="auto">
          {t("questItems.ranOut", {
            item: named(item.name, language),
            count: formatNumber(item.missed, language),
          })}
        </p>
      ))}
      <a
        className={styles.textLink}
        href={`/${language}/organizers/${organizerId}/events/${eventId}/prizes`}
      >
        {t("questItems.open")}
      </a>
    </div>
  );
}
