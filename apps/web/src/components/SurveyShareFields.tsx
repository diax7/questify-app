"use client";

import type { Language } from "@questify/shared";
import {
  OptionList,
  TextPair,
  newId,
  newItem,
  str,
  withText,
  type Item,
  type Text,
  type TypeFieldProps,
} from "#src/components/QuestTextFields.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Checkbox, Field, FieldGroup, Input, Select, Textarea } from "#src/ui/Field.tsx";

const SURVEY_KINDS = ["choice", "rating", "text"] as const;
type SurveyKind = (typeof SURVEY_KINDS)[number];
type SurveyQuestion = Readonly<{
  id: string;
  text: Text;
  kind: SurveyKind;
  required: boolean;
  choices?: readonly Item[];
}>;

/** A new survey question: a required choice between two options. */
export const newSurveyQuestion = (): SurveyQuestion => ({
  id: newId(),
  text: {},
  kind: "choice",
  required: true,
  choices: [newItem(), newItem()],
});

/** A question with another kind: choices only on a choice question, as the API wants it. */
const withKind = (question: SurveyQuestion, kind: SurveyKind): SurveyQuestion => {
  const { choices, ...rest } = question;
  return kind === "choice"
    ? { ...rest, kind, choices: choices ?? [newItem(), newItem()] }
    : { ...rest, kind };
};

function SurveyQuestionFields({
  language,
  question,
  number,
  disabled,
  change,
  remove,
}: Readonly<{
  language: Language;
  question: SurveyQuestion;
  number: number;
  disabled: boolean;
  change: (question: SurveyQuestion) => void;
  remove: (() => void) | null;
}>) {
  const t = useTranslator(language);
  return (
    <FieldGroup legend={<>{t("quests.quiz.question", { number })}</>}>
      <TextPair
        labels={{ ar: t("quests.quiz.questionAr"), en: t("quests.quiz.questionEn") }}
        text={question.text}
        max={300}
        disabled={disabled}
        change={(text) => change({ ...question, text })}
      />
      <Field label={t("quests.survey.kind")}>
        <Select
          value={question.kind}
          disabled={disabled}
          onChange={(event) => change(withKind(question, event.target.value as SurveyKind))}
        >
          {SURVEY_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`quests.survey.kind.${kind}`)}
            </option>
          ))}
        </Select>
      </Field>
      {question.kind === "choice" ? (
        <OptionList
          language={language}
          items={question.choices ?? []}
          most={10}
          disabled={disabled}
          change={(choices) => change({ ...question, choices })}
        />
      ) : null}
      <Checkbox
        label={t("quests.survey.required")}
        checked={question.required}
        disabled={disabled}
        onChange={(event) => change({ ...question, required: event.target.checked })}
      />
      {remove === null ? null : (
        <Button variant="quiet" disabled={disabled} onClick={remove}>
          {t("quests.quiz.removeQuestion", { number })}
        </Button>
      )}
    </FieldGroup>
  );
}

/**
 * A survey (T-303, ADR-198): 1 to 20 questions, each a choice, a rating from 1 to 5 or short text, required unless
 * unticked. The answers reach the owner and editors, names not shown.
 */
export function SurveyFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = useTranslator(language);
  const questions = Array.isArray(config["questions"])
    ? (config["questions"] as SurveyQuestion[])
    : [newSurveyQuestion()];
  const save = (next: readonly SurveyQuestion[]) => change({ ...config, questions: next });
  return (
    <>
      {questions.map((question, index) => (
        <SurveyQuestionFields
          key={question.id}
          language={language}
          question={question}
          number={index + 1}
          disabled={disabled}
          change={(next) => save(questions.map((one) => (one.id === question.id ? next : one)))}
          remove={
            questions.length > 1
              ? () => save(questions.filter((one) => one.id !== question.id))
              : null
          }
        />
      ))}
      {questions.length < 20 ? (
        <Button
          variant="quiet"

          disabled={disabled}
          onClick={() => save([...questions, newSurveyQuestion()])}
        >
          {t("quests.quiz.addQuestion")}
        </Button>
      ) : null}
    </>
  );
}

/**
 * A share quest (T-303, ADR-034, ADR-199): the message players share through their phone's share sheet, and an
 * optional https link. Paid once per player, with no proof; the event's switch hides them all.
 */
export function ShareFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = useTranslator(language);
  const message = (config["message"] ?? {}) as Text;
  const link = str(config["link"]);
  const setLink = (value: string) => {
    const rest = Object.fromEntries(Object.entries(config).filter(([name]) => name !== "link"));
    change(value.trim() === "" ? rest : { ...rest, link: value.trim() });
  };
  return (
    <>
      {(["ar", "en"] as const).map((key) => (
        <Field
          key={key}
          label={t(key === "ar" ? "quests.share.messageAr" : "quests.share.messageEn")}
        >
          <Textarea
            dir={key === "ar" ? "rtl" : "ltr"}
            maxLength={500}
            rows={3}
            value={str(message[key])}
            disabled={disabled}
            onChange={(event) =>
              change({ ...config, message: withText(message, key, event.target.value) })
            }
          />
        </Field>
      ))}
      <Field label={t("quests.share.link")}>
        <Input
          type="url"
          dir="ltr"
          maxLength={300}
          pattern="https://.+"
          value={link}
          disabled={disabled}
          onChange={(event) => setLink(event.target.value)}
        />
      </Field>
    </>
  );
}
