"use client";

import { formatEventTime, zoneLabel, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { Notes } from "#src/components/PrizesPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { goalsOf, type Goal } from "#src/lib/community.ts";
import {
  finaleBodyOf,
  finaleDraftOf,
  finaleReadingOf,
  invalidKeyOf,
  pushGoalsOf,
  resultsKeyOf,
  type FinaleDraft,
  type FinaleReading,
} from "#src/lib/finale.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button, ButtonLink } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;
type Translate = ReturnType<typeof useTranslator>;
type Loaded = Readonly<{ reading: FinaleReading; timeZone: string; goals: readonly Goal[] }>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
const DEFAULT_ZONE = "Asia/Riyadh";

const zoneOf = (event: Readonly<{ ok: boolean; body: unknown }>): string =>
  (event.ok ? (event.body as { event?: { timezone?: string } }).event?.timezone : undefined) ??
  DEFAULT_ZONE;

/** The finale, the event's zone and the event's goals in one go; why not, when the session is gone or it cannot be read. */
async function loadFinale(eventApi: string): Promise<Loaded | "session_lost" | "failed"> {
  const [finale, event, found] = await Promise.all([
    requestJson("GET", `${eventApi}/finale`),
    requestJson("GET", eventApi),
    requestJson("GET", `${eventApi}/community-goals`),
  ]);
  const code = errorCodeOf(finale.body);
  if (code !== undefined && SESSION_LOST.has(code)) {
    return "session_lost";
  }
  const reading = finale.ok ? finaleReadingOf(finale.body) : undefined;
  if (reading === undefined) {
    return "failed";
  }
  return {
    reading,
    timeZone: zoneOf(event),
    goals: (found.ok ? goalsOf(found.body) : undefined) ?? [],
  };
}

/** What the section reads and the form's draft; a lost session goes back to sign-in. */
function useFinale({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [reading, setReading] = useState<FinaleReading | null>(null);
  const [timeZone, setTimeZone] = useState(DEFAULT_ZONE);
  const [goals, setGoals] = useState<readonly Goal[]>([]);
  const [draft, setDraft] = useState<FinaleDraft>({ startsAt: "", goalId: "" });
  const [problem, setProblem] = useState<string | null>(null);

  const adopt = useCallback((next: FinaleReading, zone: string) => {
    setReading(next);
    setDraft(finaleDraftOf(next, zone, Date.now()));
  }, []);
  useEffect(() => {
    void loadFinale(eventApi).then((loaded) => {
      if (loaded === "session_lost") {
        window.location.assign(`/${language}/sign-in?ended=1`);
      } else if (loaded === "failed") {
        setProblem(t("finale.loadFailed"));
      } else {
        setTimeZone(loaded.timeZone);
        setGoals(loaded.goals);
        adopt(loaded.reading, loaded.timeZone);
      }
    });
  }, [eventApi, language, t, adopt]);
  return { eventApi, reading, timeZone, goals, draft, setDraft, problem, setProblem, adopt };
}

/** The line about the winners: where the results stand, and the way to the page that confirms and reveals them. */
function ResultsLine({
  language,
  reading,
  timeZone,
  resultsHref,
}: Readonly<{
  language: Language;
  reading: FinaleReading;
  timeZone: string;
  resultsHref: string;
}>) {
  const t = useTranslator(language);
  const end =
    reading.endsAt === null ? "—" : formatEventTime(new Date(reading.endsAt), timeZone, language);
  return (
    <>
      <Muted>{t(resultsKeyOf(reading.state), { end })}</Muted>
      <Toolbar>
        <ButtonLink href={resultsHref}>{t("finale.results.link")}</ButtonLink>
      </Toolbar>
    </>
  );
}

/** One goal as an option: its title and its window in the event's zone. */
function goalLabel(goal: Goal, t: Translate, language: Language, timeZone: string): string {
  return t("finale.goalOption", {
    title: textFor(goal.title, language),
    start: formatEventTime(new Date(goal.startsAt), timeZone, language),
    end: formatEventTime(new Date(goal.closesAt), timeZone, language),
  });
}

/** The time, the last push and the buttons. */
function FinaleForm({
  language,
  timeZone,
  reading,
  offered,
  draft,
  locked,
  busy,
  change,
  save,
  clear,
}: Readonly<{
  language: Language;
  timeZone: string;
  reading: FinaleReading;
  offered: readonly Goal[];
  draft: FinaleDraft;
  locked: boolean;
  busy: boolean;
  change: (draft: FinaleDraft) => void;
  save: () => void;
  clear: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Field label={t("finale.startsAt")}>
        <Input
          type="datetime-local"
          dir="ltr"
          value={draft.startsAt}
          disabled={locked}
          onChange={(event) => change({ ...draft, startsAt: event.target.value })}
        />
      </Field>
      <Muted>{zoneLabel(timeZone, language)}</Muted>
      <Field label={t("finale.goal")}>
        <Select
          value={draft.goalId}
          disabled={locked}
          onChange={(event) => change({ ...draft, goalId: event.target.value })}
        >
          <option value="">{t("finale.noGoal")}</option>
          {offered.map((goal) => (
            <option key={goal.id} value={goal.id}>
              {goalLabel(goal, t, language, timeZone)}
            </option>
          ))}
        </Select>
      </Field>
      <Toolbar>
        <Button variant="primary" type="submit" disabled={locked}>
          {t("finale.save")}
        </Button>
        {reading.finale === null ? null : (
          <Button variant="quiet" disabled={busy} onClick={clear}>
            {t("finale.clear")}
          </Button>
        )}
      </Toolbar>
    </Form>
  );
}

/** Once the finale is read: the started note, the form, and the line about the winners while a finale is set. */
function FinaleBody({
  language,
  timeZone,
  reading,
  goals,
  draft,
  busy,
  change,
  save,
  clear,
  resultsHref,
}: Readonly<{
  language: Language;
  timeZone: string;
  reading: FinaleReading;
  goals: readonly Goal[];
  draft: FinaleDraft;
  busy: boolean;
  change: (draft: FinaleDraft) => void;
  save: () => void;
  clear: () => void;
  resultsHref: string;
}>) {
  const t = useTranslator(language);
  const finale = reading.finale;
  const started = finale?.started === true;
  return (
    <>
      {started ? <Notice tone="warning">{t("finale.started")}</Notice> : null}
      <FinaleForm
        language={language}
        timeZone={timeZone}
        reading={reading}
        offered={pushGoalsOf(goals, finale?.goalId ?? null)}
        draft={draft}
        locked={busy || !reading.enabled || started}
        busy={busy}
        change={change}
        save={save}
        clear={clear}
      />
      {finale === null ? null : (
        <ResultsLine
          language={language}
          reading={reading}
          timeZone={timeZone}
          resultsHref={resultsHref}
        />
      )}
    </>
  );
}

/**
 * The event's live finale on the Big screen page (T-307b, FR-254, FR-1621): the time the countdown runs to, an optional
 * community goal as the last push, and where the winners stand. Only the owner sets or clears it; the winners are
 * confirmed and revealed on the Prizes and results page, never here.
 */
export function FinalePanel(props: Props) {
  const { language, organizerId, eventId } = props;
  const t = useTranslator(language);
  const { eventApi, reading, timeZone, goals, draft, setDraft, problem, setProblem, adopt } =
    useFinale(props);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (method: "PUT" | "DELETE", body: object | undefined, done: string) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson(method, `${eventApi}/finale`, body, {
      "idempotency-key": crypto.randomUUID(),
    });
    setBusy(false);
    const next = result.ok ? finaleReadingOf(result.body) : undefined;
    if (next !== undefined) {
      adopt(next, timeZone);
      setNotice(done);
    } else if (errorCodeOf(result.body) === "invalid_finale") {
      const details = (result.body as { details?: { field?: string } }).details;
      setProblem(t(invalidKeyOf(details?.field)));
    } else {
      setProblem(describeProblem(result.body, language, t).text);
    }
  };
  const save = () => {
    const body = finaleBodyOf(draft, timeZone);
    if (body === undefined) {
      setProblem(t("finale.invalid.startsAt"));
    } else {
      void send("PUT", body, t("finale.saved"));
    }
  };

  return (
    <Section title={t("finale.title")}>
      <Muted>{t("finale.intro")}</Muted>
      <Notes
        problem={problem}
        notice={notice}
        loading={reading === null && problem === null}
        language={language}
      />
      {reading === null ? null : (
        <FinaleBody
          language={language}
          timeZone={timeZone}
          reading={reading}
          goals={goals}
          draft={draft}
          busy={busy}
          change={setDraft}
          save={save}
          clear={() => void send("DELETE", undefined, t("finale.cleared"))}
          resultsHref={`/${language}/organizers/${organizerId}/events/${eventId}/prizes`}
        />
      )}
    </Section>
  );
}
