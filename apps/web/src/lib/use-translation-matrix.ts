"use client";

import type { Matrix, MatrixRow } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { matrixPath, readMatrix, withRow, type MatrixView } from "#src/lib/console-translations.ts";
import { requestJson } from "#src/lib/post-json.ts";

export type MatrixRead = Readonly<{
  /** The last page that came, kept on screen while the next one is on its way. */
  matrix: Matrix | null;
  loading: boolean;
  /** The API's answer, or "network", when the last read failed. */
  failure: unknown;
  /** Puts a saved row in place of the one in the list. */
  replace: (row: MatrixRow) => void;
}>;

/** Reads the matrix page for `view` and again whenever the view changes. */
export function useTranslationMatrix(view: MatrixView): MatrixRead {
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void requestJson("GET", matrixPath(view)).then((result) => {
      if (!current) {
        return;
      }
      const read = result.ok ? readMatrix(result.body) : undefined;
      if (read === undefined) {
        setFailure(result.body ?? "network");
      } else {
        setMatrix(read);
        setFailure(null);
      }
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [view]);
  const replace = useCallback(
    (row: MatrixRow) =>
      setMatrix((now) => (now === null ? now : { ...now, rows: withRow(now.rows, row) })),
    [],
  );
  return { matrix, loading, failure, replace };
}
