"use client";

import {
  MEET_DAILY_CAP,
  POLL_MINUTES,
  type Language,
  type MessageKey,
  type QuestType,
} from "@questify/shared";
import type { ReactNode } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  OptionList,
  TextPair,
  itemsOf,
  newId,
  newItem,
  str,
  type Config,
  type Item,
  type TypeFieldProps,
} from "#src/components/QuestTextFields.tsx";
import { GameFields } from "#src/components/GameFields.tsx";
import { NumberField } from "#src/components/NumberField.tsx";
import { NEW_LIVE_BLOCK } from "#src/lib/polls.ts";
import { PassportFields } from "#src/components/PassportFields.tsx";
import {
  ShareFields,
  SurveyFields,
  newSurveyQuestion,
} from "#src/components/SurveyShareFields.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Input, Radio, Select } from "#src/ui/Field.tsx";
import { SubHeading } from "#src/ui/Section.tsx";

/** A meet quest (T-303c): its daily cap per player, beside the repeat cap (the most people a player meets for points). */
function MeetFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = useTranslator(language);
  const value = config["dailyCap"];
  return (
    <NumberField
      label={t("quests.meet.dailyCap")}
      value={typeof value === "number" || typeof value === "string" ? value : ""}
      invalid={false}
      disabled={disabled}
      change={(text) => change({ ...config, dailyCap: text === "" ? "" : Number(text) })}
    />
  );
}

/** The code players type, and where the team shows it. Members see the code; players never do. */
function EnterCodeFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = useTranslator(language);
  const hint = (config["hint"] ?? {}) as Readonly<{ ar?: string; en?: string }>;
  const setHint = (key: "ar" | "en", value: string) => {
    const next = { ...hint, [key]: value === "" ? undefined : value };
    const empty = next.ar === undefined && next.en === undefined;
    const rest = Object.fromEntries(Object.entries(config).filter(([name]) => name !== "hint"));
    change(empty ? rest : { ...rest, hint: next });
  };
  return (
    <>
      <Field label={t("quests.field.code")}>
        <Input
          dir="ltr"
          required
          pattern="[A-Za-z0-9]{4,32}"
          autoCapitalize="characters"
          value={str(config["code"])}
          disabled={disabled}
          onChange={(event) => change({ ...config, code: event.target.value.toUpperCase() })}
        />
      </Field>
      <Muted>{t("quests.field.codeHint")}</Muted>
      {(["ar", "en"] as const).map((key) => (
        <Field key={key} label={t(key === "ar" ? "quests.field.hintAr" : "quests.field.hintEn")}>
          <Input
            dir={key === "ar" ? "rtl" : "ltr"}
            maxLength={200}
            value={str(hint[key])}
            disabled={disabled}
            onChange={(event) => setHint(key, event.target.value)}
          />
        </Field>
      ))}
    </>
  );
}

/**
 * A submission quest (T-301): text only for now (FR-1006; photos are T-301b), approved by the team or at once, and
 * whether a rejected player may send again (FR-1709).
 */
function SubmissionFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = useTranslator(language);
  const toggle = (name: "autoApprove" | "resubmit", label: MessageKey) => (
    <Checkbox
      label={t(label)}
      checked={config[name] === true}
      disabled={disabled}
      onChange={(event) => change({ ...config, accepts: ["text"], [name]: event.target.checked })}
    />
  );
  return (
    <>
      {toggle("autoApprove", "quests.submission.autoApprove")}
      {toggle("resubmit", "quests.submission.resubmit")}
    </>
  );
}

type Question = Item & Readonly<{ choices: readonly Item[]; right: string }>;

type LiveBlock = Readonly<{ choices: string; results: string; minutes: number | string }>;

/**
 * A live poll's settings (T-306, FR-239 to FR-242): one or several choices, when players see the results, and how many
 * minutes it stays open once sent. Choices and minutes are fixed once it is sent.
 */
function LivePollFields({
  language,
  live,
  disabled,
  sent,
  change,
}: Readonly<{
  language: Language;
  live: LiveBlock;
  disabled: boolean;
  sent: boolean;
  change: (live: LiveBlock) => void;
}>) {
  const t = useTranslator(language);
  const radio = (name: "choices" | "results", value: string, label: MessageKey, fixed: boolean) => (
    <Radio
      key={value}
      label={t(label)}
      name={`poll-${name}`}
      checked={live[name] === value}
      disabled={disabled || fixed}
      onChange={() => change({ ...live, [name]: value })}
    />
  );
  return (
    <>
      <Muted>{t("quests.poll.helper")}</Muted>
      {sent ? <Muted>{t("quests.poll.sentLocked")}</Muted> : null}
      <FieldGroup legend={t("quests.poll.choices")}>
        {radio("choices", "one", "quests.poll.one", sent)}
        {radio("choices", "several", "quests.poll.several", sent)}
      </FieldGroup>
      <FieldGroup legend={t("quests.poll.results")}>
        {radio("results", "after_vote", "quests.poll.afterVote", false)}
        {radio("results", "at_close", "quests.poll.atClose", false)}
        {radio("results", "never", "quests.poll.never", false)}
      </FieldGroup>
      <NumberField
        label={t("quests.poll.minutes")}
        value={live.minutes}
        invalid={
          typeof live.minutes !== "number" ||
          live.minutes < POLL_MINUTES.min ||
          live.minutes > POLL_MINUTES.max
        }
        disabled={disabled || sent}
        change={(text) => change({ ...live, minutes: text === "" ? "" : Number(text) })}
      />
    </>
  );
}

/**
 * A vote (T-302): 2 to 10 options the organizer writes (FR-1629: never a player's submission); ticked Live poll, it is
 * sent and closed from the quest list (T-306).
 */
function VoteFields({ language, config, disabled, change, sent = false }: TypeFieldProps) {
  const t = useTranslator(language);
  const live = config["live"] as LiveBlock | undefined;
  const plain = Object.fromEntries(Object.entries(config).filter(([name]) => name !== "live"));
  return (
    <FieldGroup legend={t("quests.vote.options")}>
      <OptionList
        language={language}
        items={itemsOf(config["options"], 2)}
        most={10}
        disabled={disabled}
        change={(options) => change({ ...config, options })}
      />
      <Checkbox
        label={t("quests.poll.live")}
        checked={live !== undefined}
        disabled={disabled || sent}
        onChange={(event) =>
          change(event.target.checked ? { ...config, live: NEW_LIVE_BLOCK } : plain)
        }
      />
      {live === undefined ? null : (
        <LivePollFields
          language={language}
          live={live}
          disabled={disabled}
          sent={sent}
          change={(next) => change({ ...config, live: next })}
        />
      )}
    </FieldGroup>
  );
}

const newQuestion = (): Question => {
  const choices = [newItem(), newItem()];
  return { id: newId(), text: {}, choices, right: choices[0]?.id ?? "" };
};

/** One quiz question: its words, its choices, and which one is right. */
function QuestionFields({
  language,
  question,
  number,
  disabled,
  change,
  remove,
}: Readonly<{
  language: Language;
  question: Question;
  number: number;
  disabled: boolean;
  change: (question: Question) => void;
  remove: (() => void) | null;
}>) {
  const t = useTranslator(language);
  const setChoices = (choices: readonly Item[]) =>
    change({
      ...question,
      choices,
      right: choices.some((choice) => choice.id === question.right)
        ? question.right
        : (choices[0]?.id ?? ""),
    });
  return (
    <FieldGroup legend={<>{t("quests.quiz.question", { number })}</>}>
      <TextPair
        labels={{ ar: t("quests.quiz.questionAr"), en: t("quests.quiz.questionEn") }}
        text={question.text}
        max={300}
        disabled={disabled}
        change={(text) => change({ ...question, text })}
      />
      <OptionList
        language={language}
        items={question.choices}
        most={6}
        disabled={disabled}
        change={setChoices}
      />
      <Field label={t("quests.quiz.right")}>
        <Select
          value={question.right}
          disabled={disabled}
          onChange={(event) => change({ ...question, right: event.target.value })}
        >
          {question.choices.map((choice, index) => (
            <option key={choice.id} value={choice.id}>
              {t("quests.quiz.rightChoice", { number: index + 1 })}
            </option>
          ))}
        </Select>
      </Field>
      {remove === null ? null : (
        <Button variant="quiet" disabled={disabled} onClick={remove}>
          {t("quests.quiz.removeQuestion", { number })}
        </Button>
      )}
    </FieldGroup>
  );
}

/** A quiz (T-302): 1 to 20 questions, 2 to 6 choices each, one right; an optional timer for every question. */
function QuizFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = useTranslator(language);
  const questions = Array.isArray(config["questions"])
    ? (config["questions"] as Question[])
    : [newQuestion()];
  const timer = typeof config["timerSeconds"] === "number" ? config["timerSeconds"] : null;
  const save = (next: readonly Question[], timerSeconds: number | null) =>
    change({ ...config, questions: next, timerSeconds });
  return (
    <>
      <Field label={t("quests.quiz.timer")}>
        <Input
          type="number"
          dir="ltr"
          min={5}
          max={300}
          value={timer === null ? "" : String(timer)}
          disabled={disabled}
          onChange={(event) =>
            save(questions, event.target.value === "" ? null : Number(event.target.value))
          }
        />
      </Field>
      <SubHeading as="h3">{t("quests.quiz.questions")}</SubHeading>
      {questions.map((question, index) => (
        <QuestionFields
          key={question.id}
          language={language}
          question={question}
          number={index + 1}
          disabled={disabled}
          change={(next) =>
            save(
              questions.map((one) => (one.id === question.id ? next : one)),
              timer,
            )
          }
          remove={
            questions.length > 1
              ? () =>
                  save(
                    questions.filter((one) => one.id !== question.id),
                    timer,
                  )
              : null
          }
        />
      ))}
      {questions.length < 20 ? (
        <Button
          variant="quiet"

          disabled={disabled}
          onClick={() => save([...questions, newQuestion()], timer)}
        >
          {t("quests.quiz.addQuestion")}
        </Button>
      ) : null}
    </>
  );
}

/** The config a new quest of this type starts from: a vote's two options, a quiz's or a survey's first question. */
export function startingConfig(type: QuestType): Config {
  switch (type) {
    case "vote":
      return { options: [newItem(), newItem()] };
    case "quiz":
      return { questions: [newQuestion()], timerSeconds: null };
    case "survey":
      return { questions: [newSurveyQuestion()] };
    case "share":
      return { message: {} };
    case "passport":
      return { needed: 1, steps: [newItem()] };
    case "meet":
      return { dailyCap: MEET_DAILY_CAP.default };
    case "game":
      return { game: "memory_match", level: "easy", attempts: 1, cooldownMinutes: null };
    default:
      return {};
  }
}

/** A type with nothing to set: a QR scan, a challenge the team confirms, a check-in (the place is `QuestPlaceFields`). */
const noFields = (): ReactNode => null;

/**
 * The form fields each quest type adds (FR-1505). Typed by the registry's keys, so a type added to the registry
 * without its fields here fails the type check.
 */
export const QUEST_TYPE_FIELDS: Readonly<Record<QuestType, (props: TypeFieldProps) => ReactNode>> =
  {
    scan_qr: noFields,
    enter_code: EnterCodeFields,
    submission: SubmissionFields,
    vote: VoteFields,
    quiz: QuizFields,
    challenge: noFields,
    survey: SurveyFields,
    share: ShareFields,
    passport: PassportFields,
    location: noFields,
    meet: MeetFields,
    game: GameFields,
  };
