import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "#src/api/app-session.ts";
import { appendPage, createSingleFlight } from "#src/questify/event-pages.ts";
import { fetchEventPage } from "#src/questify/questify-api.ts";
import type { OwnEvent } from "@questify/shared";

export type Read<T> = Readonly<{
  /** The last answer that fit; kept while a newer read is on its way or has failed. */
  data: T | null;
  /** The latest read failed: say so with a retry, never show it as an empty list. */
  failed: boolean;
  retry: () => void;
}>;

/**
 * Reads again each time the screen gains focus, when `reloadOn` changes (a sync wrote something) and on retry. An
 * answer that arrives after a newer read began is dropped.
 */
export function useRead<T>(load: () => Promise<T | null>, reloadOn: readonly unknown[]): Read<T> {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  // The first focus is the mount, which already reads; every later focus reads again.
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current) setTick((current) => current + 1);
      focused.current = true;
    }, []),
  );
  const retry = useCallback(() => setTick((current) => current + 1), []);
  useEffect(() => {
    let current = true;
    void loadRef.current().then((answer) => {
      if (!current) return;
      setFailed(answer === null);
      if (answer !== null) setData(answer);
    });
    return () => {
      current = false;
    };
    // `reloadOn` is the caller's list of reasons to read again.
  }, [tick, ...reloadOn]);
  return { data, failed, retry };
}

export type EventPages = Readonly<{
  rows: readonly OwnEvent[] | null;
  failed: boolean;
  retry: () => void;
  /** Null when the last page has been read. */
  more: (() => void) | null;
}>;

/** The caller's events, newest first: the passport with `played`, the history without it; pages are appended. */
export function useEventPages(played: boolean, reloadOn: readonly unknown[]): EventPages {
  const first = useRead(() => fetchEventPage(api.session, { played, cursor: null }), reloadOn);
  const [extra, setExtra] = useState<readonly OwnEvent[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [failedMore, setFailedMore] = useState(false);
  // A fresh first page replaces what was appended: the list may have changed.
  useEffect(() => {
    setExtra([]);
    setCursor(undefined);
    setFailedMore(false);
  }, [first.data]);
  const [flight] = useState(createSingleFlight);
  const next = cursor === undefined ? (first.data?.nextCursor ?? null) : cursor;
  const more =
    next === null
      ? null
      : () =>
          void flight(async () => {
            const page = await fetchEventPage(api.session, { played, cursor: next });
            setFailedMore(page === null);
            if (page === null) return;
            setExtra((current) => appendPage(current, page.events));
            setCursor(page.nextCursor);
          });
  return {
    rows: first.data === null ? null : [...first.data.events, ...extra],
    failed: first.failed || failedMore,
    retry: first.retry,
    more,
  };
}
