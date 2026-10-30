"use client";

import { formatNumber, type AdminDailyQuestion, type Language } from "@questify/shared";
import type { FormEvent } from "react";
import { formatPeriod, textIn } from "#src/lib/console-daily.ts";
import { canPick, type ChallengeDraft } from "#src/lib/console-daily-forms.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { Card, SubHeading, Toolbar } from "#src/ui/Section.tsx";

const POSITIONS = [0, 1, 2] as const;

/** What players will see: each chosen question in both languages with its right option marked, and the sponsor line. */
function Preview({
  language,
  draft,
  questions,
}: Readonly<{
  language: Language;
  draft: ChallengeDraft;
  questions: readonly AdminDailyQuestion[];
}>) {
  const t = translatorFor(language);
  const chosen = draft.questionIds
    .map((id) => questions.find((question) => question.id === id))
    .filter((question): question is AdminDailyQuestion => question !== undefined);
  const sponsorAr = draft.sponsorAr.trim();
  const sponsorEn = draft.sponsorEn.trim();
  if (chosen.length === 0 && sponsorAr === "" && sponsorEn === "") {
    return null;
  }
  return (
    <Card data-testid="daily-preview">
      <strong>{t("console.daily.preview")}</strong>
      {sponsorAr === "" || sponsorEn === "" ? null : (
        <Muted>
          <span lang="ar" dir="rtl">
            {translatorFor("ar")("daily.sponsor", { name: sponsorAr })}
          </span>
          {" / "}
          <span lang="en" dir="ltr">
            {translatorFor("en")("daily.sponsor", { name: sponsorEn })}
          </span>
        </Muted>
      )}
      <ol>
        {chosen.map((question) => (
          <li key={question.id} dir="auto">
            {textIn(question.prompt, language)}
            <ul>
              {question.options.map((option, index) => (
                <li key={`${question.id}-${String(index)}`} dir="auto">
                  {textIn(option, language)}
                  {index + 1 === question.answer ? ` (${t("console.daily.rightAnswer")})` : ""}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** One period's challenge: three questions from the bank, an optional sponsor name in both languages, a preview. */
export function ChallengeEditor({
  language,
  startsOn,
  endsOn,
  draft,
  questions,
  busy,
  change,
  cancel,
  submit,
}: Readonly<{
  language: Language;
  startsOn: string;
  endsOn: string;
  draft: ChallengeDraft;
  questions: readonly AdminDailyQuestion[];
  busy: boolean;
  change: (patch: Partial<ChallengeDraft>) => void;
  cancel: () => void;
  submit: (event: FormEvent) => void;
}>) {
  const t = translatorFor(language);
  const eligible = questions.filter((question) => canPick(question, startsOn));
  const choose = (position: number, id: string) => {
    const ids = [...draft.questionIds] as [string, string, string];
    ids[position] = id;
    change({ questionIds: ids });
  };
  return (
    <Form card onSubmit={submit} data-testid="daily-challenge-editor">
      <SubHeading>
        {t("console.daily.editorTitle", { period: formatPeriod(startsOn, endsOn, language) })}
      </SubHeading>
      {eligible.length < 3 ? <Muted>{t("console.daily.needQuestions")}</Muted> : null}
      {POSITIONS.map((position) => (
        <Field
          label={t("console.daily.questionN", { position: formatNumber(position + 1, language) })}
        >
          <Select
            value={draft.questionIds[position]}
            disabled={busy}
            onChange={(event) => choose(position, event.target.value)}
          >
            <option value="">{t("console.daily.pick")}</option>
            {eligible
              .filter(
                (question) =>
                  question.id === draft.questionIds[position] ||
                  !draft.questionIds.includes(question.id),
              )
              .map((question) => (
                <option key={question.id} value={question.id}>
                  {textIn(question.prompt, language)}
                </option>
              ))}
          </Select>
        </Field>
      ))}
      <Field label={t("console.daily.field.sponsorAr")}>
        <Input
          dir="rtl"
          lang="ar"
          maxLength={60}
          value={draft.sponsorAr}
          disabled={busy}
          onChange={(event) => change({ sponsorAr: event.target.value })}
        />
      </Field>
      <Field label={t("console.daily.field.sponsorEn")}>
        <Input
          dir="ltr"
          lang="en"
          maxLength={60}
          value={draft.sponsorEn}
          disabled={busy}
          onChange={(event) => change({ sponsorEn: event.target.value })}
        />
      </Field>
      <Muted>{t("console.daily.sponsorHelp")}</Muted>
      <Preview language={language} draft={draft} questions={questions} />
      <Toolbar>
        <Button variant="quiet" disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("console.daily.saveChallenge")}
        </Button>
      </Toolbar>
    </Form>
  );
}
