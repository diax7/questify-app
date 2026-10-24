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
  ChallengeFields,
  ShareFields,
  SurveyFields,
  newSurveyQuestion,
} from "#src/components/SurveyShareFields.tsx";
import styles from "#src/components/layout.module.css";

function ScanQrFields({ language }: TypeFieldProps) {
  return <p className={styles.muted}>{useTranslator(language)("quests.scanQrNote")}</p>;
}

/** A location quest: what a check-in trusts, and that the QR always works (the place itself is `QuestPlaceFields`). */
function LocationFields({ language }: TypeFieldProps) {
  const t = useTranslator(language);
  return (
    <>
      <p className={styles.muted}>{t("quests.location.note")}</p>
      <p className={styles.muted}>{t("quests.location.qr")}</p>
    </>
  );
}

/**
 * A meet quest (T-303c): its daily cap per player beside the repeat cap (the most people a player meets for points),
 * and how the one-minute code works.
 */
function MeetFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = useTranslator(language);
  const value = config["dailyCap"];
  return (
    <>
      <p className={styles.muted}>{t("quests.meet.note")}</p>
      <NumberField
        label={t("quests.meet.dailyCap")}
        value={typeof value === "number" || typeof value === "string" ? value : ""}
        invalid={false}
        disabled={disabled}
        change={(text) => change({ ...config, dailyCap: text === "" ? "" : Number(text) })}
      />
      <p className={styles.muted}>{t("quests.meet.repeatCap")}</p>
    </>
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
      <label className={styles.field}>
        {t("quests.field.code")}
        <input
          className={styles.input}
          dir="ltr"
          required
          pattern="[A-Za-z0-9]{4,32}"
          autoCapitalize="characters"
          value={str(config["code"])}
          disabled={disabled}
          onChange={(event) => change({ ...config, code: event.target.value.toUpperCase() })}
        />
      </label>
      <p className={styles.muted}>{t("quests.field.codeHint")}</p>
      {(["ar", "en"] as const).map((key) => (
        <label key={key} className={styles.field}>
          {t(key === "ar" ? "quests.field.hintAr" : "quests.field.hintEn")}
          <input
            className={styles.input}
            dir={key === "ar" ? "rtl" : "ltr"}
            maxLength={200}
            value={str(hint[key])}
            disabled={disabled}
            onChange={(event) => setHint(key, event.target.value)}
          />
        </label>
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
    <label className={styles.check}>
      <input
        type="checkbox"
        checked={config[name] === true}
        disabled={disabled}
        onChange={(event) => change({ ...config, accepts: ["text"], [name]: event.target.checked })}
      />
      {t(label)}
    </label>
  );
  return (
    <>
      <p className={styles.muted}>{t("quests.submission.textOnly")}</p>
      {toggle("autoApprove", "quests.submission.autoApprove")}
      <p className={styles.muted}>{t("quests.submission.autoApproveHint")}</p>
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
    <label key={value} className={styles.check}>
      <input
        type="radio"
        name={`poll-${name}`}
        checked={live[name] === value}
        disabled={disabled || fixed}
        onChange={() => change({ ...live, [name]: value })}
      />
      <span>{t(label)}</span>
    </label>
  );
  return (
    <>
      <p className={styles.muted}>{t("quests.poll.helper")}</p>
      <p className={styles.muted}>{t(sent ? "quests.poll.sentLocked" : "quests.poll.window")}</p>
      <fieldset className={styles.field}>
        <legend>{t("quests.poll.choices")}</legend>
        {radio("choices", "one", "quests.poll.one", sent)}
        {radio("choices", "several", "quests.poll.several", sent)}
      </fieldset>
      <fieldset className={styles.field}>
        <legend>{t("quests.poll.results")}</legend>
        {radio("results", "after_vote", "quests.poll.afterVote", false)}
        {radio("results", "at_close", "quests.poll.atClose", false)}
        {radio("results", "never", "quests.poll.never", false)}
      </fieldset>
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
    <fieldset className={styles.field}>
      <legend>{t("quests.vote.options")}</legend>
      <p className={styles.muted}>{t("quests.vote.note")}</p>
      <OptionList
        language={language}
        items={itemsOf(config["options"], 2)}
        most={10}
        disabled={disabled}
        change={(options) => change({ ...config, options })}
      />
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={live !== undefined}
          disabled={disabled || sent}
          onChange={(event) =>
            change(event.target.checked ? { ...config, live: NEW_LIVE_BLOCK } : plain)
          }
        />
        <span>{t("quests.poll.live")}</span>
      </label>
      {live === undefined ? null : (
        <LivePollFields
          language={language}
          live={live}
          disabled={disabled}
          sent={sent}
          change={(next) => change({ ...config, live: next })}
        />
      )}
    </fieldset>
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
    <fieldset className={styles.field}>
      <legend>{t("quests.quiz.question", { number })}</legend>
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
      <label className={styles.field}>
        {t("quests.quiz.right")}
        <select
          className={styles.input}
          value={question.right}
          disabled={disabled}
          onChange={(event) => change({ ...question, right: event.target.value })}
        >
          {question.choices.map((choice, index) => (
            <option key={choice.id} value={choice.id}>
              {t("quests.quiz.rightChoice", { number: index + 1 })}
            </option>
          ))}
        </select>
      </label>
      {remove === null ? null : (
        <button type="button" className={styles.quiet} disabled={disabled} onClick={remove}>
          {t("quests.quiz.removeQuestion", { number })}
        </button>
      )}
    </fieldset>
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
      <p className={styles.muted}>{t("quests.quiz.note")}</p>
      <label className={styles.field}>
        {t("quests.quiz.timer")}
        <input
          className={styles.input}
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
      </label>
      <h3 className={styles.subtitle}>{t("quests.quiz.questions")}</h3>
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
        <button
          type="button"
          className={styles.quiet}
          disabled={disabled}
          onClick={() => save([...questions, newQuestion()], timer)}
        >
          {t("quests.quiz.addQuestion")}
        </button>
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

/**
 * The form fields each quest type adds (FR-1505). Typed by the registry's keys, so a type added to the registry
 * without its fields here fails the type check.
 */
export const QUEST_TYPE_FIELDS: Readonly<Record<QuestType, (props: TypeFieldProps) => ReactNode>> =
  {
    scan_qr: ScanQrFields,
    enter_code: EnterCodeFields,
    submission: SubmissionFields,
    vote: VoteFields,
    quiz: QuizFields,
    challenge: ChallengeFields,
    survey: SurveyFields,
    share: ShareFields,
    passport: PassportFields,
    location: LocationFields,
    meet: MeetFields,
    game: GameFields,
  };
