"use client";

import { legalInForceSchema, organizerDocuments, type OrganizerDocument } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { requestJson } from "#src/lib/post-json.ts";

export type OrganizerDocuments =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; retry: () => void }>
  | Readonly<{ kind: "ready"; documents: readonly OrganizerDocument[] }>;

/** The organizer documents in force, read from the API (`GET /v1/legal`) so a new version needs no release. */
export function useOrganizerDocuments(): OrganizerDocuments {
  const [state, setState] = useState<Exclude<OrganizerDocuments, { kind: "failed" }>>({
    kind: "loading",
  });
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  const retry = useCallback(() => {
    setFailed(false);
    setRound((before) => before + 1);
  }, []);
  useEffect(() => {
    let alive = true;
    void requestJson("GET", "/v1/legal").then((result) => {
      const parsed = result.ok ? legalInForceSchema.safeParse(result.body) : undefined;
      if (!alive) {
        return;
      }
      if (parsed?.success !== true) {
        setFailed(true);
        return;
      }
      setState({ kind: "ready", documents: organizerDocuments(parsed.data.documents) });
    });
    return () => {
      alive = false;
    };
  }, [round]);
  return failed ? { kind: "failed", retry } : state;
}
