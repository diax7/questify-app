"use client";

import { formatNumber, surveyResultsCsv, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { SurveyShare } from "#src/components/SurveyShare.tsx";
import { downloadText } from "#src/lib/download-text.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import {
  surveyCsvLabels,
  surveyResultsOf,
  type SurveyQuestionResult,
  type SurveyResults as Results,
} from "#src/lib/surveys.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { CardList, Section } from "#src/ui/Section.tsx";

export function QuestionResult({
  language,
  question,
}: Readonly<{ language: Language; question: SurveyQuestionResult }>) {
  const t = translatorFor(language);
  return (
    <li>
      <strong>{textFor(question.text, language)}</strong>
      <Muted>
        {t("quests.survey.answeredCount", { count: formatNumber(question.answered, language) })}
      </Muted>
      {question.choices === null ? null : (
        <CardList>
          {question.choices.map((choice) => (
            <li key={choice.id}>
              {t("quests.vote.count", {
                option: textFor(choice.text, language),
                votes: formatNumber(choice.count, language),
              })}
            </li>
          ))}
        </CardList>
      )}
      {question.average === null ? null : (
        <p>{t("quests.survey.average", { average: formatNumber(question.average, language) })}</p>
      )}
      {question.texts === null || question.texts.length === 0 ? null : (
        <CardList>
          {question.texts.map((text, index) => (
            <li key={`${question.id}-${index}`} dir="auto">
              {text}
            </li>
          ))}
        </CardList>
      )}
    </li>
  );
}

/**
 * A survey quest's results for the team (FR-1209, FR-1624, ADR-198): counts, averages and the newest 50 texts, names not
 * shown, with the spreadsheet export and the speaker's link (FR-1210). `url` is the quest's survey route; the share
 * route sits beside it.
 */
export function SurveyResults({ language, url }: Readonly<{ language: Language; url: string }>) {
  const t = translatorFor(language);
  const [results, setResults] = useState<Results | null>(null);
  useEffect(() => {
    let live = true;
    void requestJson("GET", url).then((result) => {
      if (live && result.ok) {
        setResults(surveyResultsOf(result.body) ?? null);
      }
    });
    return () => {
      live = false;
    };
  }, [url]);
  if (results === null) {
    return null;
  }
  return (
    <Section
      level={3}
      title={t("quests.survey.results")}
      titleId="survey-results"
      actions={
        <Button
          variant="quiet"
          onClick={() =>
            downloadText(
              "survey-results.csv",
              surveyResultsCsv(results, language, surveyCsvLabels(t)),
            )
          }
        >
          {t("surveyResults.export")}
        </Button>
      }
    >
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
      <SurveyShare language={language} url={`${url}-share`} />
    </Section>
  );
}
