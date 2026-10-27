"use client";

import { DAILY_LANGUAGES, formatNumber, type DailyLanguage, type Language } from "@questify/shared";
import { DailyWordImport } from "#src/components/DailyWordImport.tsx";
import { LANGUAGE_NAME_KEY } from "#src/lib/console-daily.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useWordList } from "#src/lib/use-word-list.ts";
import styles from "#src/components/layout.module.css";

type List = ReturnType<typeof useWordList>;
type Pages = Pick<List, "data" | "prefix" | "page" | "pages" | "setPage" | "listLanguage"> &
  Readonly<{ language: Language }>;

/** The words of the page read, how many match a search, and the buttons to move between pages. */
function WordPages({ language, listLanguage, data, prefix, page, pages, setPage }: Pages) {
  const t = translatorFor(language);
  if (data === null) {
    return null;
  }
  return (
    <>
      {prefix === "" ? null : (
        <p className={styles.muted}>
          {t("console.words.matches", { count: formatNumber(data.total, language) })}
        </p>
      )}
      {data.words.length === 0 ? (
        <p className={styles.muted}>{t("console.words.noMatches")}</p>
      ) : (
        <p
          data-testid="word-list-words"
          dir={listLanguage === "ar" ? "rtl" : "ltr"}
          lang={listLanguage}
          className={styles.prose}
        >
          {data.words.join("  ")}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.quiet}
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          {t("console.words.previous")}
        </button>
        <span className={styles.muted}>
          {t("console.words.page", {
            page: formatNumber(page, language),
            pages: formatNumber(pages, language),
          })}
        </span>
        <button
          type="button"
          className={styles.quiet}
          disabled={page >= pages}
          onClick={() => setPage(page + 1)}
        >
          {t("console.words.next")}
        </button>
      </div>
    </>
  );
}

/**
 * The guess list of one language (FR-1811): its size, a search by the start of a word with pages, and the import.
 * Only the words in the list, or the period's own word, are valid guesses.
 */
export function DailyWordList({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const list = useWordList(language);
  return (
    <section aria-labelledby="daily-list" className={styles.stack}>
      <h2 id="daily-list" className={styles.subtitle}>
        {t("console.words.list")}
      </h2>
      <label className={styles.field}>
        {t("console.words.listLanguage")}
        <select
          className={styles.input}
          value={list.listLanguage}
          onChange={(event) => list.pick(event.target.value as DailyLanguage)}
        >
          {DAILY_LANGUAGES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {t(LANGUAGE_NAME_KEY[candidate])}
            </option>
          ))}
        </select>
      </label>
      {list.listTotal === null ? null : (
        <p data-testid="word-list-count">
          {t("console.words.count", { count: formatNumber(list.listTotal, language) })}
        </p>
      )}
      <form className={styles.form} onSubmit={list.search}>
        <label className={styles.field}>
          {t("console.words.search")}
          <input
            className={styles.input}
            dir={list.listLanguage === "ar" ? "rtl" : "ltr"}
            lang={list.listLanguage}
            maxLength={40}
            value={list.typed}
            onChange={(event) => list.setTyped(event.target.value)}
          />
        </label>
        <div className={styles.actions}>
          <button type="submit" className={styles.button}>
            {t("console.words.searchButton")}
          </button>
        </div>
      </form>
      {list.problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {list.problem}
        </p>
      )}
      <WordPages
        language={language}
        listLanguage={list.listLanguage}
        data={list.data}
        prefix={list.prefix}
        page={list.page}
        pages={list.pages}
        setPage={list.setPage}
      />
      <DailyWordImport
        language={language}
        listLanguage={list.listLanguage}
        changed={list.changed}
      />
    </section>
  );
}
