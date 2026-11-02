"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "#src/lib/post-json.ts";

export type ConsoleRead<T> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "ready"; value: T }>;

/**
 * One read of a console API path, checked by `read` (undefined means the answer was not the expected shape). The
 * previous value stays on screen while `reload` runs. The console answers one read at a time per admin and bucket, so a
 * reload asked while one is running joins it, and the page's own periodic reread (`everyMs`) never replaces what is on
 * screen with a failure: only a reload the person asked for does.
 */
export function useConsoleRead<T>(
  path: string,
  read: (body: unknown) => T | undefined,
  everyMs?: number,
): Readonly<{ state: ConsoleRead<T>; reload: () => Promise<void> }> {
  const [state, setState] = useState<ConsoleRead<T>>({ kind: "loading" });
  const running = useRef<Promise<void> | null>(null);
  const load = useCallback(
    async (background: boolean) => {
      const result = await requestJson("GET", path);
      const value = result.ok ? read(result.body) : undefined;
      setState((before) => {
        if (value !== undefined) {
          return { kind: "ready", value };
        }
        return background && before.kind === "ready" ? before : { kind: "failed" };
      });
    },
    [path, read],
  );
  const start = useCallback(
    (background: boolean): Promise<void> => {
      running.current ??= load(background).finally(() => {
        running.current = null;
      });
      return running.current;
    },
    [load],
  );
  const reload = useCallback(() => start(false), [start]);
  useEffect(() => {
    void start(false);
    if (everyMs === undefined) {
      return undefined;
    }
    const timer = setInterval(() => void start(true), everyMs);
    return () => clearInterval(timer);
  }, [start, everyMs]);
  return { state, reload };
}
