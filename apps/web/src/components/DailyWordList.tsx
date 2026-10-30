"use client";

import { DAILY_LANGUAGES, formatNumber, type DailyLanguage, type Language } from "@questify/shared";
import { DailyWordImport } from "#src/components/DailyWordImport.tsx";
import { LANGUAGE_NAME_KEY } from "#src/lib/console-daily.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useWordList } from "#src/lib/use-word-list.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { Prose } from "#src/ui/Text.tsx";

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
        <Muted>{t("console.words.matches", { count: formatNumber(data.total, language) })}</Muted>
      )}
      {data.words.length === 0 ? (
        <Muted>{t("console.words.noMatches")}</Muted>
      ) : (
        <Prose
          data-testid="word-list-words"
          dir={listLanguage === "ar" ? "rtl" : "ltr"}
          lang={listLanguage}
        >
          {data.words.join("  ")}
        </Prose>
      )}
      <Toolbar>
        <Button variant="quiet" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          {t("console.words.previous")}
        </Button>
        <Muted as="span">
          {t("console.words.page", {
            page: formatNumber(page, language),
            pages: formatNumber(pages, language),
          })}
        </Muted>
        <Button variant="quiet" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          {t("console.words.next")}
        </Button>
      </Toolbar>
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
    <Stack as="section" aria-labelledby="daily-list">
      <SubHeading as="h2" id="daily-list">
        {t("console.words.list")}
      </SubHeading>
      <Field label={t("console.words.listLanguage")}>
        <Select
          value={list.listLanguage}
          onChange={(event) => list.pick(event.target.value as DailyLanguage)}
        >
          {DAILY_LANGUAGES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {t(LANGUAGE_NAME_KEY[candidate])}
            </option>
          ))}
        </Select>
      </Field>
      {list.listTotal === null ? null : (
        <p data-testid="word-list-count">
          {t("console.words.count", { count: formatNumber(list.listTotal, language) })}
        </p>
      )}
      <Form onSubmit={list.search}>
        <Field label={t("console.words.search")}>
          <Input
            dir={list.listLanguage === "ar" ? "rtl" : "ltr"}
            lang={list.listLanguage}
            maxLength={40}
            value={list.typed}
            onChange={(event) => list.setTyped(event.target.value)}
          />
        </Field>
        <Toolbar>
          <Button variant="primary" type="submit">
            {t("console.words.searchButton")}
          </Button>
        </Toolbar>
      </Form>
      {list.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {list.problem}
        </Notice>
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
    </Stack>
  );
}
