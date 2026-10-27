"use client";

import type { DailyLanguage, Language, WordListPage } from "@questify/shared";
import { useEffect, useState, type FormEvent } from "react";
import { API, readWordListPage } from "#src/lib/console-daily.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { problemText } from "#src/lib/use-daily-console.ts";

/** The API answers this many words a page. */
export const WORD_PAGE_SIZE = 100;

/** One language's guess list as the page reads it: the search by the start of a word, the page, and its size. */
export function useWordList(language: Language) {
  const [listLanguage, setListLanguage] = useState<DailyLanguage>(language);
  const [typed, setTyped] = useState("");
  const [prefix, setPrefix] = useState("");
  const [page, setPage] = useState(1);
  const [reads, setReads] = useState(0);
  const [data, setData] = useState<WordListPage | null>(null);
  const [listTotal, setListTotal] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const query = `prefix=${encodeURIComponent(prefix)}&page=${String(page)}`;
    void requestJson("GET", `${API}/word-list/${listLanguage}?${query}`).then((result) => {
      if (!current) {
        return;
      }
      const read = result.ok ? readWordListPage(result.body) : undefined;
      if (read === undefined) {
        setProblem(problemText(result.body, language));
        return;
      }
      setProblem(null);
      setData(read);
      if (prefix === "") {
        setListTotal(read.total);
      }
    });
    return () => {
      current = false;
    };
  }, [listLanguage, prefix, page, reads, language]);

  return {
    listLanguage,
    typed,
    setTyped,
    prefix,
    page,
    setPage,
    pages: data === null ? 1 : Math.max(1, Math.ceil(data.total / WORD_PAGE_SIZE)),
    data,
    listTotal,
    problem,
    search: (event: FormEvent) => {
      event.preventDefault();
      setPage(1);
      setPrefix(typed.trim());
    },
    pick: (next: DailyLanguage) => {
      setListLanguage(next);
      setTyped("");
      setPrefix("");
      setPage(1);
      setData(null);
      setListTotal(null);
    },
    /** The list changed: its new size, and read the page again. */
    changed: (total: number) => {
      setListTotal(total);
      setReads((count) => count + 1);
    },
  };
}
