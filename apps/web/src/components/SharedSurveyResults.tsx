"use client";

import {
  formatNumber,
  sharedSurveyResultsSchema,
  type Language,
  type SharedSurveyResults as Results,
} from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { QuestionResult } from "#src/components/SurveyResults.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import { tokenFromHash } from "#src/lib/survey-links.ts";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";

type State =
  | Readonly<{ kind: "reading" | "missing" | "unavailable" | "throttled" | "failed" }>
  | Readonly<{ kind: "found"; results: Results }>;

const NOTES = {
  missing: "surveyShared.missing",
  unavailable: "surveyShared.unavailable",
  throttled: "surveyShared.throttled",
  failed: "surveyShared.failed",
} as const;

function stateOf(result: Awaited<ReturnType<typeof requestJson>>): State {
  if (result.ok) {
    const parsed = sharedSurveyResultsSchema.safeParse(result.body);
    return parsed.success ? { kind: "found", results: parsed.data } : { kind: "failed" };
  }
  if (result.status === 404) return { kind: "unavailable" };
  if (result.status === 429) return { kind: "throttled" };
  return { kind: "failed" };
}

function Found({ language, results }: Readonly<{ language: Language; results: Results }>) {
  const t = translatorFor(language);
  const hidden = results.questions.reduce((sum, question) => sum + (question.hiddenTexts ?? 0), 0);
  return (
    <>
      <PageHeader
        titleId="shared-survey-title"
        title={
          <span dir="auto" data-testid="shared-survey-quest">
            {textFor(results.quest, language)}
          </span>
        }
      />
      <Muted dir="auto">{textFor(results.event, language)}</Muted>
      <Muted>
        {t("quests.survey.total", { total: formatNumber(results.total, language) })}{" "}
        {t("quests.survey.namesNotShown")}
      </Muted>
      {results.total === 0 ? null : (
        <ol>
          {results.questions.map((question) => (
            <QuestionResult key={question.id} language={language} question={question} />
          ))}
        </ol>
      )}
      {hidden === 0 ? null : (
        <Notice tone="info" role="status">
          {t("surveyShared.hidden", { count: formatNumber(hidden, language) })}
        </Notice>
      )}
    </>
  );
}

/**
 * The speaker's page (T-508, FR-1210, ADR-376 (5)): one survey quest's results, opened by a link whose token is in the
 * fragment, so no server log or `Referer` has it. The token is sent once in a body to the public door; the page keeps it
 * in the address so a reload works. It shows counts, averages and text answers, never a name.
 */
export function SharedSurveyResults({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [state, setState] = useState<State>({ kind: "reading" });
  const taken = useRef(false);

  // Once per page, also under Strict Mode's double effect: a second send would only be counted by the open's limit.
  useEffect(() => {
    if (taken.current) return;
    taken.current = true;
    const token = tokenFromHash(window.location.hash);
    if (token === undefined) {
      setState({ kind: "missing" });
      return;
    }
    void requestJson("POST", "/v1/public/survey-results", { token }).then((result) => {
      setState(stateOf(result));
    });
  }, []);

  return (
    <Stack as="section" aria-labelledby="shared-survey-title">
      {state.kind === "found" ? (
        <Found language={language} results={state.results} />
      ) : (
        <>
          <PageHeader titleId="shared-survey-title" title={t("surveyShared.title")} />
          {state.kind === "reading" ? (
            <Muted role="status">{t("common.loading")}</Muted>
          ) : (
            <Notice tone="danger" role="alert">
              {t(NOTES[state.kind])}
            </Notice>
          )}
        </>
      )}
    </Stack>
  );
}
