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
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

/** A challenge (T-303, ADR-197): nothing to set; the description says what to do, and staff confirm it. */
export function ChallengeFields({ language }: TypeFieldProps) {
  return <p className={styles.muted}>{translatorFor(language)("quests.challenge.note")}</p>;
}

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
  const t = translatorFor(language);
  return (
    <fieldset className={styles.field}>
      <legend>{t("quests.quiz.question", { number })}</legend>
      <TextPair
        labels={{ ar: t("quests.quiz.questionAr"), en: t("quests.quiz.questionEn") }}
        text={question.text}
        max={300}
        disabled={disabled}
        change={(text) => change({ ...question, text })}
      />
      <label className={styles.field}>
        {t("quests.survey.kind")}
        <select
          className={styles.input}
          value={question.kind}
          disabled={disabled}
          onChange={(event) => change(withKind(question, event.target.value as SurveyKind))}
        >
          {SURVEY_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`quests.survey.kind.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      {question.kind === "choice" ? (
        <OptionList
          language={language}
          items={question.choices ?? []}
          most={10}
          disabled={disabled}
          change={(choices) => change({ ...question, choices })}
        />
      ) : null}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={question.required}
          disabled={disabled}
          onChange={(event) => change({ ...question, required: event.target.checked })}
        />
        <span>{t("quests.survey.required")}</span>
      </label>
      {remove === null ? null : (
        <button type="button" className={styles.quiet} disabled={disabled} onClick={remove}>
          {t("quests.quiz.removeQuestion", { number })}
        </button>
      )}
    </fieldset>
  );
}

/**
 * A survey (T-303, ADR-198): 1 to 20 questions, each a choice, a rating from 1 to 5 or short text, required unless
 * unticked. The answers reach the owner and editors, names not shown.
 */
export function SurveyFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = translatorFor(language);
  const questions = Array.isArray(config["questions"])
    ? (config["questions"] as SurveyQuestion[])
    : [newSurveyQuestion()];
  const save = (next: readonly SurveyQuestion[]) => change({ ...config, questions: next });
  return (
    <>
      <p className={styles.muted}>{t("quests.survey.note")}</p>
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
        <button
          type="button"
          className={styles.quiet}
          disabled={disabled}
          onClick={() => save([...questions, newSurveyQuestion()])}
        >
          {t("quests.quiz.addQuestion")}
        </button>
      ) : null}
    </>
  );
}

/**
 * A share quest (T-303, ADR-034, ADR-199): the message players share through their phone's share sheet, and an
 * optional https link. Paid once per player, with no proof; the event's switch hides them all.
 */
export function ShareFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = translatorFor(language);
  const message = (config["message"] ?? {}) as Text;
  const link = str(config["link"]);
  const setLink = (value: string) => {
    const rest = Object.fromEntries(Object.entries(config).filter(([name]) => name !== "link"));
    change(value.trim() === "" ? rest : { ...rest, link: value.trim() });
  };
  return (
    <>
      <p className={styles.muted}>{t("quests.share.note")}</p>
      {(["ar", "en"] as const).map((key) => (
        <label key={key} className={styles.field}>
          {t(key === "ar" ? "quests.share.messageAr" : "quests.share.messageEn")}
          <textarea
            className={styles.input}
            dir={key === "ar" ? "rtl" : "ltr"}
            maxLength={500}
            rows={3}
            value={str(message[key])}
            disabled={disabled}
            onChange={(event) =>
              change({ ...config, message: withText(message, key, event.target.value) })
            }
          />
        </label>
      ))}
      <label className={styles.field}>
        {t("quests.share.link")}
        <input
          className={styles.input}
          type="url"
          dir="ltr"
          maxLength={300}
          pattern="https://.+"
          value={link}
          disabled={disabled}
          onChange={(event) => setLink(event.target.value)}
        />
      </label>
    </>
  );
}
