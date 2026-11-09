"use client";

import {
  WORD_LANGUAGES,
  formatNumber,
  type AllowWord,
  type Language,
  type WordLanguage,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ConfirmedButton, Problem, keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import {
  ALLOW_API,
  allowPath,
  allowWordPath,
  readAllowWords,
  type AllowFilter,
} from "#src/lib/console-words.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type Loaded =
  | Readonly<{ rows: readonly AllowWord[]; total: number; more: string | null }>
  | "failed";

const NO_FILTER: AllowFilter = { q: "", language: "" };

/** The allow-list pages for a filter: the first page, then "Show more" adds the next after the last word. */
function useAllowWords(filter: AllowFilter, version: number) {
  const [state, setState] = useState<Loaded | null>(null);
  const load = useCallback(
    async (after: string | null, before: readonly AllowWord[]) => {
      const result = await requestJson("GET", allowPath(filter, after));
      const page = result.ok ? readAllowWords(result.body) : undefined;
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
    more: (shown: Loaded) => {
      if (shown !== "failed" && shown.more !== null) {
        void load(shown.more, shown.rows);
      }
    },
  };
}

function AllowFilters({
  language,
  filter,
  change,
}: Readonly<{ language: Language; filter: AllowFilter; change: (next: AllowFilter) => void }>) {
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
    </Toolbar>
  );
}

/** A new allow word. The API folds it as the full-name check reads a name and takes its language from its letters. */
function AddAllowWord({
  language,
  onAdded,
}: Readonly<{ language: Language; onAdded: (done: string) => void }>) {
  const t = translatorFor(language);
  const [word, setWord] = useState("");
  const { busy, problem, run } = useWrite(language, (done) => {
    setWord("");
    onAdded(done);
  });
  return (
    <Form
      onSubmit={(submitted) => {
        submitted.preventDefault();
        void run(
          () => requestJson("POST", ALLOW_API, { word: word.trim() }, keyed()),
          t("console.nameAllow.added"),
        );
      }}
    >
      <Problem problem={problem} />
      <Toolbar>
        <Field label={t("console.wordLists.word")} info={infoTip(t, "console.nameAllow.hint")}>
          <Input dir="auto" maxLength={60} value={word} onChange={(e) => setWord(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || word.trim().length < 2}>
          {t("console.nameAllow.add")}
        </Button>
      </Toolbar>
    </Form>
  );
}

/** One allow word with its language and Remove (asked once, ADR-063). */
function AllowLine({
  language,
  word,
  onRemoved,
}: Readonly<{ language: Language; word: AllowWord; onRemoved: (done: string) => void }>) {
  const t = translatorFor(language);
  const { busy, problem, run } = useWrite(language, onRemoved);
  return (
    <Row
      main={
        <Stack>
          <bdi dir="auto">{word.word}</bdi>
          <Muted as="span">{t(`console.wordLists.language.${word.language}`)}</Muted>
          <Problem problem={problem} />
        </Stack>
      }
    >
      <ConfirmedButton
        language={language}
        label={t("console.wordLists.remove")}
        question={t("console.nameAllow.removeConfirm", { word: word.word })}
        variant="danger"
        disabled={busy}
        act={() =>
          void run(
            () => requestJson("DELETE", allowWordPath(word.word), undefined, keyed()),
            t("console.nameAllow.removed"),
          )
        }
      />
    </Row>
  );
}

function AllowSection({
  language,
  onDone,
}: Readonly<{ language: Language; onDone: (done: string) => void }>) {
  const t = translatorFor(language);
  const [filter, setFilter] = useState<AllowFilter>(NO_FILTER);
  const [version, setVersion] = useState(0);
  const { state, more } = useAllowWords(filter, version);
  const changed = (done: string) => {
    setVersion((n) => n + 1);
    onDone(done);
  };
  return (
    <Section title={t("console.nameAllow.lists")}>
      <Stack>
        <AddAllowWord language={language} onAdded={changed} />
        <AllowFilters language={language} filter={filter} change={setFilter} />
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
            {state.rows.length === 0 ? (
              <Muted>
                {t(
                  filter.q.trim() === "" && filter.language === ""
                    ? "console.nameAllow.empty"
                    : "console.nameAllow.noMatch",
                )}
              </Muted>
            ) : null}
            <Rows>
              {state.rows.map((word) => (
                <AllowLine key={word.word} language={language} word={word} onRemoved={changed} />
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

/**
 * The console's full-name allow-list (FR-1779, ADR-817), beside the word lists: words of real names the full-name check
 * skips, with search and language filters, add and remove. The API refuses a list entry and a word that would let an
 * abusive name through, audits every change, and the stored names are checked again by the sweep.
 */
export function ConsoleNameAllow({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [done, setDone] = useState<string | null>(null);
  return (
    <Stack as="section" aria-labelledby="console-name-allow-title">
      <PageHeader
        title={t("console.nameAllow.title")}
        titleId="console-name-allow-title"
        info={infoTip(t, "console.nameAllow.intro")}
      />
      {done === null ? null : (
        <Notice tone="success" role="status">
          {done}
        </Notice>
      )}
      <AllowSection language={language} onDone={setDone} />
    </Stack>
  );
}
