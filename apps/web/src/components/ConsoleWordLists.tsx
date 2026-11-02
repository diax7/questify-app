"use client";

import {
  WORD_LANGUAGES,
  WORD_MATCHES,
  formatNumber,
  type Language,
  type ListWord,
  type RetiredName,
  type WordLanguage,
  type WordMatch,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ConfirmedButton, Problem, keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import {
  RELEASE_API,
  WORDS_API,
  readRetired,
  readWords,
  retiredPath,
  wordPath,
  wordsPath,
  type WordFilter,
} from "#src/lib/console-words.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type Loaded<T> = Readonly<{ rows: readonly T[]; total: number; more: string | null }> | "failed";

const NO_FILTER: WordFilter = { q: "", language: "", match: "" };

/** The word-list pages for a filter: the first page, then "Show more" adds the next after the last word. */
function useWords(filter: WordFilter, version: number) {
  const [state, setState] = useState<Loaded<ListWord> | null>(null);
  const load = useCallback(
    async (after: string | null, before: readonly ListWord[]) => {
      const result = await requestJson("GET", wordsPath(filter, after));
      const page = result.ok ? readWords(result.body) : undefined;
      if (page === undefined) {
        setState("failed");
        return;
      }
      const rows = [...before, ...page.words];
      const last = page.words.at(-1)?.word ?? null;
      setState({ rows, total: page.total, more: rows.length < page.total ? last : null });
    },
    [filter],
  );
  useEffect(() => {
    void load(null, []);
  }, [load, version]);
  return {
    state,
    more: (shown: Loaded<ListWord>) => {
      if (shown !== "failed" && shown.more !== null) {
        void load(shown.more, shown.rows);
      }
    },
  };
}

function WordFilters({
  language,
  filter,
  change,
}: Readonly<{ language: Language; filter: WordFilter; change: (next: WordFilter) => void }>) {
  const t = translatorFor(language);
  return (
    <Toolbar>
      <Field label={t("console.wordLists.search")}>
        <Input
          type="search"
          dir="auto"
          maxLength={60}
          value={filter.q}
          onChange={(changed) => change({ ...filter, q: changed.target.value })}
        />
      </Field>
      <Field label={t("console.wordLists.language")}>
        <Select
          value={filter.language}
          onChange={(changed) =>
            change({ ...filter, language: changed.target.value as WordLanguage | "" })
          }
        >
          <option value="">{t("console.wordLists.all")}</option>
          {WORD_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {t(`console.wordLists.language.${code}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("console.wordLists.match")}>
        <Select
          value={filter.match}
          onChange={(changed) =>
            change({ ...filter, match: changed.target.value as WordMatch | "" })
          }
        >
          <option value="">{t("console.wordLists.all")}</option>
          {WORD_MATCHES.map((code) => (
            <option key={code} value={code}>
              {t(`console.wordLists.match.${code}`)}
            </option>
          ))}
        </Select>
      </Field>
    </Toolbar>
  );
}

/** A new word: the word, its language and how it matches. The API folds it and refuses what cannot be a list word. */
function AddWord({
  language,
  onAdded,
}: Readonly<{ language: Language; onAdded: (done: string) => void }>) {
  const t = translatorFor(language);
  const [word, setWord] = useState("");
  const [lang, setLang] = useState<WordLanguage>("ar");
  const [match, setMatch] = useState<WordMatch>("word");
  const { busy, problem, run } = useWrite(language, (done) => {
    setWord("");
    onAdded(done);
  });
  return (
    <Form
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void run(
          () =>
            requestJson("POST", WORDS_API, { word: word.trim(), match, language: lang }, keyed()),
          t("console.wordLists.added"),
        );
      }}
    >
      <Problem problem={problem} />
      <Toolbar>
        <Field label={t("console.wordLists.word")}>
          <Input dir="auto" maxLength={60} value={word} onChange={(e) => setWord(e.target.value)} />
        </Field>
        <Field label={t("console.wordLists.language")}>
          <Select value={lang} onChange={(e) => setLang(e.target.value as WordLanguage)}>
            {WORD_LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {t(`console.wordLists.language.${code}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("console.wordLists.match")}>
          <Select value={match} onChange={(e) => setMatch(e.target.value as WordMatch)}>
            {WORD_MATCHES.map((code) => (
              <option key={code} value={code}>
                {t(`console.wordLists.match.${code}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={busy || word.trim().length < 2}>
          {t("console.wordLists.add")}
        </Button>
      </Toolbar>
    </Form>
  );
}

/** One list word with its language, match and Remove (asked once, ADR-063). */
function WordLine({
  language,
  word,
  onRemoved,
}: Readonly<{ language: Language; word: ListWord; onRemoved: (done: string) => void }>) {
  const t = translatorFor(language);
  const { busy, problem, run } = useWrite(language, onRemoved);
  return (
    <Row
      main={
        <Stack>
          <bdi dir="auto">{word.word}</bdi>
          <Muted as="span">
            {t(`console.wordLists.language.${word.language}`)}
            {" · "}
            {t(`console.wordLists.match.${word.match}`)}
          </Muted>
          <Problem problem={problem} />
        </Stack>
      }
    >
      <ConfirmedButton
        language={language}
        label={t("console.wordLists.remove")}
        question={t("console.wordLists.removeConfirm", { word: word.word })}
        variant="danger"
        disabled={busy}
        act={() =>
          void run(
            () => requestJson("DELETE", wordPath(word.word), undefined, keyed()),
            t("console.wordLists.removed"),
          )
        }
      />
    </Row>
  );
}

function WordsSection({
  language,
  onDone,
}: Readonly<{ language: Language; onDone: (done: string) => void }>) {
  const t = translatorFor(language);
  const [filter, setFilter] = useState<WordFilter>(NO_FILTER);
  const [version, setVersion] = useState(0);
  const { state, more } = useWords(filter, version);
  const changed = (done: string) => {
    setVersion((n) => n + 1);
    onDone(done);
  };
  return (
    <Section title={t("console.wordLists.lists")}>
      <Stack>
        <AddWord language={language} onAdded={changed} />
        <WordFilters language={language} filter={filter} change={setFilter} />
        {state === "failed" ? (
          <Notice tone="danger" role="alert">
            {t("console.wordLists.loadFailed")}
          </Notice>
        ) : null}
        {state !== null && state !== "failed" ? (
          <>
            <Muted>
              {t("console.wordLists.total", { count: formatNumber(state.total, language) })}
            </Muted>
            {state.rows.length === 0 ? <Muted>{t("console.wordLists.empty")}</Muted> : null}
            <Rows>
              {state.rows.map((word) => (
                <WordLine key={word.word} language={language} word={word} onRemoved={changed} />
              ))}
            </Rows>
            {state.more === null ? null : (
              <Toolbar>
                <Button variant="secondary" onClick={() => more(state)}>
                  {t("console.wordLists.more")}
                </Button>
              </Toolbar>
            )}
          </>
        ) : null}
      </Stack>
    </Section>
  );
}

function RetiredLine({
  language,
  name,
  onReleased,
}: Readonly<{ language: Language; name: RetiredName; onReleased: (done: string) => void }>) {
  const t = translatorFor(language);
  const { busy, problem, run } = useWrite(language, onReleased);
  return (
    <Row
      main={
        <Stack>
          <bdi dir="auto">@{name.fold}</bdi>
          <Problem problem={problem} />
        </Stack>
      }
    >
      <ConfirmedButton
        language={language}
        label={t("console.wordLists.retired.release")}
        question={t("console.wordLists.retired.releaseConfirm", { name: `@${name.fold}` })}
        variant="secondary"
        disabled={busy}
        act={() =>
          void run(
            () => requestJson("POST", RELEASE_API, { username: name.fold }, keyed()),
            t("console.wordLists.retired.released"),
          )
        }
      />
    </Row>
  );
}

/** The names Questify took from players (ADR-420): nobody takes one until it is released here. */
function RetiredSection({
  language,
  onDone,
}: Readonly<{ language: Language; onDone: (done: string) => void }>) {
  const t = translatorFor(language);
  const [q, setQ] = useState("");
  const [version, setVersion] = useState(0);
  const [names, setNames] = useState<RetiredName[] | "failed" | null>(null);
  useEffect(() => {
    let alive = true;
    void requestJson("GET", retiredPath(q, null)).then((result) => {
      if (alive) {
        setNames((result.ok ? readRetired(result.body) : undefined) ?? "failed");
      }
    });
    return () => {
      alive = false;
    };
  }, [q, version]);
  const released = (done: string) => {
    setVersion((n) => n + 1);
    onDone(done);
  };
  return (
    <Section
      title={t("console.wordLists.retired")}
      info={infoTip(t, "console.wordLists.retired.intro")}
    >
      <Stack>
        <Field label={t("console.wordLists.search")}>
          <Input
            type="search"
            dir="auto"
            maxLength={60}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </Field>
        {names === "failed" ? (
          <Notice tone="danger" role="alert">
            {t("console.wordLists.loadFailed")}
          </Notice>
        ) : null}
        {Array.isArray(names) && names.length === 0 ? (
          <Muted>{t("console.wordLists.retired.empty")}</Muted>
        ) : null}
        {Array.isArray(names) ? (
          <Rows>
            {names.map((name) => (
              <RetiredLine key={name.fold} language={language} name={name} onReleased={released} />
            ))}
          </Rows>
        ) : null}
      </Stack>
    </Section>
  );
}

/**
 * The console's word lists (T-705, FR-1779): the username word lists, with search, language and match filters, add and
 * remove; and the retired usernames with release. A change applies at once to sign-up, rename and the marking of
 * player text, and never renames anyone. Every change is audited by the API.
 */
export function ConsoleWordLists({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [done, setDone] = useState<string | null>(null);
  return (
    <Stack as="section" aria-labelledby="console-word-lists-title">
      <PageHeader
        title={t("console.wordLists.title")}
        titleId="console-word-lists-title"
        info={infoTip(t, "console.wordLists.intro")}
      />
      {done === null ? null : (
        <Notice tone="success" role="status">
          {done}
        </Notice>
      )}
      <WordsSection language={language} onDone={setDone} />
      <RetiredSection language={language} onDone={setDone} />
    </Stack>
  );
}
