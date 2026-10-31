"use client";

import { useCallback, useEffect, useState } from "react";

/** Tells a page that a form (named by `source`) holds edits it has not saved, or no longer does. */
export type ReportUnsaved = (source: string, unsaved: boolean) => void;

/** The sources that hold unsaved edits after `source` reports `unsaved`; the same set when nothing changed. */
export function withReport(
  sources: ReadonlySet<string>,
  source: string,
  unsaved: boolean,
): ReadonlySet<string> {
  if (sources.has(source) === unsaved) {
    return sources;
  }
  const next = new Set(sources);
  if (unsaved) {
    next.add(source);
  } else {
    next.delete(source);
  }
  return next;
}

/** Collects the reports of the forms on a page: whether any of them holds unsaved edits right now. */
export function useUnsavedReports(): Readonly<{ unsaved: boolean; report: ReportUnsaved }> {
  const [sources, setSources] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback<ReportUnsaved>(
    (source, unsaved) => setSources((current) => withReport(current, source, unsaved)),
    [],
  );
  return { unsaved: sources.size > 0, report };
}

/** Reports a form's unsaved state to the page that asked, and that it has none once the form is gone. */
export function useReportUnsaved(
  report: ReportUnsaved | undefined,
  source: string,
  unsaved: boolean,
): void {
  useEffect(() => {
    report?.(source, unsaved);
  }, [report, source, unsaved]);
  useEffect(() => () => report?.(source, false), [report, source]);
}
