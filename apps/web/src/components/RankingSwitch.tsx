"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { useConfirmation } from "#src/components/useConfirmation.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import { Switch } from "#src/ui/Field.tsx";
import { Row, SubHeading } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The two switches: the event's ranking (FR-607) and today's ranking for a multi-day event (FR-608). */
export const SWITCHES = {
  ranking: {
    path: "ranking",
    title: "events.ranking.title",
    label: "events.ranking.label",
    info: "events.ranking.hint",
  },
  rankingToday: {
    path: "ranking-today",
    title: "events.ranking.todayTitle",
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
  /** Which of the two the owner is offered: the platform may keep either off for this organizer (FR-1826). */
  offered: Readonly<Record<Feature, boolean>>;
  myRole: "owner" | "editor";
  /** The event is live: hiding a ranking then asks first (FR-1031), since players lose it at once. */
  live: boolean;
}>;

/**
 * The event's ranking switches (FR-607, FR-608): the owner hides the ranking, or only today's ranking, from players and
 * shows it again; an editor sees which it is. A change is saved as soon as a box is ticked or cleared; in a live event,
 * turning one off asks first, like the other event switches. A switch the platform keeps off for the organizer is not
 * offered, and with neither offered the section is not shown (FR-1826).
 */
export function RankingSwitch({
  language,
  organizerId,
  eventId,
  initial,
  offered,
  myRole,
  live,
}: Props) {
  const t = translatorFor(language);
  const confirmation = useConfirmation(language);
  const [shown, setShown] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (feature: Feature, enabled: boolean) => {
    if (busy) return;
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

  if (!offered.ranking && !offered.rankingToday) {
    return null;
  }
  return (
    <Row
      as="section"
      aria-labelledby="ranking-title"
      main={
        <>
          <SubHeading id="ranking-title">{t("events.ranking.title")}</SubHeading>
          {(Object.keys(SWITCHES) as Feature[])
            .filter((feature) => offered[feature])
            .map((feature) => (
              <Switch
                key={feature}
                label={t(SWITCHES[feature].label)}
                info={infoTip(t, SWITCHES[feature].info)}
                checked={shown[feature]}
                disabled={myRole !== "owner"}
                aria-busy={busy}
                onChange={(changed) => {
                  const enabled = changed.target.checked;
                  if (enabled || !live) {
                    void save(feature, enabled);
                    return;
                  }
                  confirmation.ask({
                    title: t("events.switchOff.title", { feature: t(SWITCHES[feature].title) }),
                    body: t("events.switchOff.body"),
                    confirmLabel: t("events.switchOff.confirm"),
                    run: () => save(feature, false),
                  });
                }}
              />
            ))}
          {problem === null ? null : (
            <Notice role="alert" tone="danger">
              {problem}
            </Notice>
          )}
          {confirmation.dialog}
        </>
      }
    />
  );
}
