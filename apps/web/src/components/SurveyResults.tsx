"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import {
  surveyResultsOf,
  type SurveyQuestionResult,
  type SurveyResults as Results,
} from "#src/lib/surveys.ts";
import { Muted } from "#src/ui/Feedback.tsx";
import { Card, CardList, SubHeading } from "#src/ui/Section.tsx";

function QuestionResult({
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

/** A survey quest's results for the team (ADR-198): counts, averages and the newest 50 texts, names not shown. */
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
    <Card as="section" aria-labelledby="survey-results">
      <SubHeading as="h3" id="survey-results">
        {t("quests.survey.results")}
      </SubHeading>
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
    </Card>
  );
}
