"use client";

import {
  formatNumber,
  questRatingScoresSchema,
  questScorePercent,
  type Language,
  type QuestRatingScore,
} from "@questify/shared";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { Badge } from "#src/ui/Feedback.tsx";

const NO_SCORES: ReadonlyMap<string, QuestRatingScore> = new Map();
const Scores = createContext<ReadonlyMap<string, QuestRatingScore>>(NO_SCORES);

/**
 * Reads the event's quest ratings once for the badges under it (FR-1211: each quest shows the score its ratings give).
 * The badge is information only, so a failed read shows no badge and no message.
 */
export function QuestScoresScope({
  organizerId,
  eventId,
  children,
}: Readonly<{ organizerId: string; eventId: string; children: ReactNode }>) {
  const [scores, setScores] = useState(NO_SCORES);
  useEffect(() => {
    let current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}/quest-ratings`).then(
      (result) => {
        const parsed = result.ok ? questRatingScoresSchema.safeParse(result.body) : null;
        if (current && parsed?.success === true) {
          setScores(new Map(parsed.data.scores.map((score) => [score.questId, score])));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [organizerId, eventId]);
  return <Scores value={scores}>{children}</Scores>;
}

/** A quest's score from its thumbs, "80% liked (8 up, 2 down)"; nothing for a quest nobody rated. */
export function QuestScoreBadge({
  language,
  questId,
}: Readonly<{ language: Language; questId: string }>) {
  const t = useTranslator(language);
  const score = useContext(Scores).get(questId);
  const percent = score === undefined ? null : questScorePercent(score);
  return score === undefined || percent === null ? null : (
    <Badge tone="info">
      {t("quests.rating.score", {
        percent: formatNumber(percent, language),
        up: formatNumber(score.up, language),
        down: formatNumber(score.down, language),
      })}
    </Badge>
  );
}
