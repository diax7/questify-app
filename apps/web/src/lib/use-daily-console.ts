"use client";

import type { AdminDailyQuestion, DailyConsole, Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import {
  API,
  questifyDayOf,
  readDailyConsole,
  readQuestions,
  refusalOf,
  scheduleRange,
  touchesBank,
} from "#src/lib/console-daily.ts";
import { translatorFor } from "#src/lib/language.ts";
import { isTransientFailure, requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { useRequestKey } from "#src/lib/use-request-key.ts";

const BANK_PAGE = 100;
/** A safety stop for the bank's pages (5,000 questions); the bank is filled by hand. */
const BANK_PAGES_MAX = 50;

export type DailyWrite = (
  call: Readonly<{
    method: "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    done?: string;
  }>,
) => Promise<Readonly<{ body: unknown }> | null>;

/** The words for a failed call: this page's own for the daily refusals, else the API's message. */
export function problemText(body: unknown, language: Language): string {
  const t = translatorFor(language);
  const refusal = refusalOf(body);
  return refusal === undefined
    ? describeProblem(body, language, t).text
    : t(refusal.key, refusal.params);
}

/** Every question of the bank, newest first, page after page; the failed answer when a page is not the expected shape. */
async function loadBank(): Promise<{ questions: AdminDailyQuestion[] } | { failed: unknown }> {
  const questions: AdminDailyQuestion[] = [];
  for (let page = 0; page < BANK_PAGES_MAX; page += 1) {
    const last = questions.at(-1);
    const before = last === undefined ? "" : `&before=${last.id}`;
    const result = await requestJson("GET", `${API}/questions?limit=${BANK_PAGE}${before}`);
    const read = result.ok ? readQuestions(result.body) : undefined;
    if (read === undefined) {
      return { failed: result.body };
    }
    questions.push(...read);
    if (read.length < BANK_PAGE) {
      break;
    }
  }
  return { questions };
}

/**
 * The state the Content page's tabs share (T-406c): the schedule with its warnings, the question bank, and one write
 * at a time. Every write carries an Idempotency-Key, and the page reads again after it so the warnings stay true.
 */
export function useDailyConsole(language: Language) {
  const [today] = useState(() => questifyDayOf(new Date()));
  const [view, setView] = useState<DailyConsole | null>(null);
  const [questions, setQuestions] = useState<AdminDailyQuestion[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRequestKey();

  /** Reads the schedule, and the whole bank unless only the schedule can have changed. */
  const load = async (withBank = true): Promise<void> => {
    const { from, to } = scheduleRange(today);
    const [schedule, bank] = await Promise.all([
      requestJson("GET", `${API}?from=${from}&to=${to}`),
      withBank ? loadBank() : Promise.resolve(null),
    ]);
    const read = schedule.ok ? readDailyConsole(schedule.body) : undefined;
    if (read === undefined) {
      setProblem(problemText(schedule.body, language));
      return;
    }
    if (bank !== null && "failed" in bank) {
      setProblem(problemText(bank.failed, language));
      return;
    }
    setView(read);
    if (bank !== null) {
      setQuestions(bank.questions);
    }
  };
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load();
    // Once per page, also under Strict Mode's double effect.
  }, []);

  const write: DailyWrite = async (call) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const signature = `${call.method} ${call.path} ${JSON.stringify(call.body ?? null)}`;
    const result = await requestJson(call.method, `${API}${call.path}`, call.body, {
      "idempotency-key": request.keyFor(signature),
    });
    if (!result.ok) {
      if (!isTransientFailure(result)) {
        request.forget();
      }
      setProblem(problemText(result.body, language));
      setBusy(false);
      return null;
    }
    request.forget();
    if (call.done !== undefined) {
      setNotice(call.done);
    }
    await load(touchesBank(call.path));
    setBusy(false);
    return { body: result.body };
  };
  return { today, view, questions, problem, setProblem, notice, setNotice, busy, write };
}

export type DailyConsoleState = ReturnType<typeof useDailyConsole>;
