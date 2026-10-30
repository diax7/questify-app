"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import { Switch } from "#src/ui/Field.tsx";
import { Row, SubHeading } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The two switches: the event's ranking (FR-607) and today's ranking for a multi-day event (FR-608). */
const SWITCHES = {
  ranking: { path: "ranking", label: "events.ranking.label", info: "events.ranking.hint" },
  rankingToday: {
    path: "ranking-today",
    label: "events.ranking.todayLabel",
    info: "events.ranking.todayHint",
  },
} as const;

type Feature = keyof typeof SWITCHES;

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  /** The event's switches as the page last read them. */
  initial: Readonly<Record<Feature, boolean>>;
  myRole: "owner" | "editor";
}>;

/**
 * The event's ranking switches (FR-607, FR-608): the owner hides the ranking, or only today's ranking, from players and
 * shows it again; an editor sees which it is. A change is saved as soon as a box is ticked or cleared.
 */
export function RankingSwitch({ language, organizerId, eventId, initial, myRole }: Props) {
  const t = translatorFor(language);
  const [shown, setShown] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (feature: Feature, enabled: boolean) => {
    const before = shown[feature];
    // The box changes at once; a refused save puts it back and says why.
    setShown((now) => ({ ...now, [feature]: enabled }));
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "PUT",
      `/v1/organizers/${organizerId}/events/${eventId}/${SWITCHES[feature].path}`,
      { enabled },
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    if (!result.ok) {
      setShown((now) => ({ ...now, [feature]: before }));
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    const saved = (result.body as Partial<Record<Feature, unknown>>)[feature] === true;
    setShown((now) => ({ ...now, [feature]: saved }));
  };

  return (
    <Row
      as="section"
      aria-labelledby="ranking-title"
      main={
        <>
          <SubHeading id="ranking-title">{t("events.ranking.title")}</SubHeading>
          {(Object.keys(SWITCHES) as Feature[]).map((feature) => (
            <Switch
              key={feature}
              label={t(SWITCHES[feature].label)}
              info={infoTip(t, SWITCHES[feature].info)}
              checked={shown[feature]}
              disabled={busy || myRole !== "owner"}
              onChange={(changed) => void save(feature, changed.target.checked)}
            />
          ))}
          {problem === null ? null : (
            <Notice role="alert" tone="danger">
              {problem}
            </Notice>
          )}
        </>
      }
    />
  );
}
