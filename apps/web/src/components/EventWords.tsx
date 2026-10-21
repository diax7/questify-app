"use client";

import {
  CURRENCY_ICONS,
  TERM_MAX,
  readEventTerms,
  termFor,
  type EventTerms,
  type Language,
} from "@questify/shared";
import { useState, type FormEvent } from "react";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import {
  FORMS,
  WORDS,
  checkTerms,
  previewOf,
  termFieldOf,
  type TermField,
  type WordKey,
} from "#src/lib/terms.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
const LANGUAGES: readonly Language[] = ["ar", "en"];

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  /** The event's words as the page last read them, defaults filled. */
  initial: EventTerms;
  saved: (terms: EventTerms) => void;
}>;

const inputId = (field: TermField) => `term-${field.word}-${field.language}-${field.form}`;

/** One word's four forms: singular and plural, in Arabic and in English. */
function WordFields({
  language,
  word,
  draft,
  invalid,
  busy,
  change,
}: Readonly<{
  language: Language;
  word: WordKey;
  draft: EventTerms;
  invalid: TermField | undefined;
  busy: boolean;
  change: (field: TermField, text: string) => void;
}>) {
  const t = translatorFor(language);
  return (
    <div className={styles.row}>
      {LANGUAGES.flatMap((formLanguage) =>
        FORMS.map((form) => {
          const field = { word, language: formLanguage, form };
          const wrong =
            invalid?.word === word && invalid.language === formLanguage && invalid.form === form;
          return (
            <label key={inputId(field)} className={styles.field}>
              <span>{t(`terms.form.${formLanguage}.${form}`)}</span>
              <input
                id={inputId(field)}
                className={styles.input}
                lang={formLanguage}
                dir={directionOf(formLanguage)}
                maxLength={TERM_MAX}
                value={draft[word][formLanguage][form]}
                disabled={busy}
                aria-invalid={wrong}
                onChange={(changed) => change(field, changed.target.value)}
              />
            </label>
          );
        }),
      )}
    </div>
  );
}

/** The five images FR-405 names; there is no upload. */
function IconChoice({
  language,
  icon,
  busy,
  choose,
}: Readonly<{
  language: Language;
  icon: EventTerms["currency"]["icon"];
  busy: boolean;
  choose: (icon: EventTerms["currency"]["icon"]) => void;
}>) {
  const t = translatorFor(language);
  return (
    <fieldset className={styles.choices}>
      <legend>{t("terms.icon")}</legend>
      {CURRENCY_ICONS.map((option) => (
        <label key={option} className={styles.check}>
          <input
            type="radio"
            name="currency-icon"
            value={option}
            checked={icon === option}
            disabled={busy}
            onChange={() => choose(option)}
          />
          <img src={`/currency/${option}.png`} alt="" width={32} height={32} />
          <span>{t(`terms.icon.${option}`)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** How the words read where the app and the dashboard use them, in both languages (plan T-117, m4). */
function Preview({ language, draft }: Readonly<{ language: Language; draft: EventTerms }>) {
  const t = translatorFor(language);
  const shown = previewOf(draft);
  return (
    <div className={styles.card}>
      <h3 className={styles.subtitle}>{t("terms.preview")}</h3>
      {LANGUAGES.map((previewLanguage) => {
        const p = translatorFor(previewLanguage);
        return (
          <div key={previewLanguage} lang={previewLanguage} dir={directionOf(previewLanguage)}>
            <p>
              {p("quests.pointsShort", {
                currency: termFor(shown.currency, previewLanguage),
                points: 120,
              })}
            </p>
            <p>{p("players.title", { players: termFor(shown.player, previewLanguage) })}</p>
            <p>
              {p("quests.repeatShort", { player: shown.player[previewLanguage].one, count: 3 })}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The event's words (FR-404, FR-405, FR-940): the currency's name and icon, and what players and operators are called.
 * The whole set is saved at once; a word left empty keeps Questify's default. A missing form is named before sending.
 */
export function EventWords({ language, organizerId, eventId, initial, saved }: Props) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<EventTerms>(initial);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<TermField | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refuse = (field: TermField | undefined, body?: unknown) => {
    setInvalid(field);
    if (field === undefined) {
      setProblem(describeProblem(body, language, t).text);
      return;
    }
    setProblem(
      t("terms.invalid", {
        word: t(`terms.word.${field.word}`),
        field: t(`terms.form.${field.language}.${field.form}`),
      }),
    );
    document.getElementById(inputId(field))?.focus();
  };

  const submit = async (submitted: FormEvent<HTMLFormElement>) => {
    submitted.preventDefault();
    setProblem(null);
    setNotice(null);
    const checked = checkTerms(draft);
    if (!checked.ok) {
      refuse(checked.field);
      return;
    }
    setBusy(true);
    const result = await requestJson(
      "PUT",
      `/v1/organizers/${organizerId}/events/${eventId}/terms`,
      checked.body,
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    if (!result.ok) {
      const field = (result.body as { details?: { field?: unknown } } | undefined)?.details?.field;
      refuse(code === "invalid_terms" ? termFieldOf(field) : undefined, result.body);
      return;
    }
    const terms = readEventTerms((result.body as { terms?: unknown }).terms);
    setInvalid(undefined);
    setDraft(terms);
    saved(terms);
    setNotice(t("terms.saved"));
  };

  const change = (field: TermField, text: string) =>
    setDraft((current) => {
      const word = current[field.word];
      const forms = { ...word[field.language], [field.form]: text };
      return { ...current, [field.word]: { ...word, [field.language]: forms } };
    });

  return (
    <section className={styles.card} aria-labelledby="terms-title">
      <h2 id="terms-title" className={styles.subtitle}>
        {t("terms.title")}
      </h2>
      <p className={styles.muted}>{t("terms.intro")}</p>
      <form className={styles.form} noValidate onSubmit={(submitted) => void submit(submitted)}>
        {WORDS.map((word) => (
          <fieldset key={word} className={styles.choices}>
            <legend>{t(`terms.word.${word}`)}</legend>
            {word === "operator" ? <p className={styles.muted}>{t("terms.operatorHint")}</p> : null}
            {word === "currency" ? (
              <IconChoice
                language={language}
                icon={draft.currency.icon}
                busy={busy}
                choose={(icon) =>
                  setDraft((current) => ({ ...current, currency: { ...current.currency, icon } }))
                }
              />
            ) : null}
            <WordFields
              language={language}
              word={word}
              draft={draft}
              invalid={invalid}
              busy={busy}
              change={change}
            />
          </fieldset>
        ))}
        <p className={styles.muted}>{t("terms.enHint")}</p>
        <Preview language={language} draft={draft} />
        {problem === null ? null : (
          <p role="alert" className={styles.alert}>
            {problem}
          </p>
        )}
        {notice === null ? null : (
          <p role="status" className={styles.notice}>
            {notice}
          </p>
        )}
        <button type="submit" className={styles.button} disabled={busy}>
          {t("terms.save")}
        </button>
      </form>
    </section>
  );
}
