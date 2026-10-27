"use client";
import type { Language } from "@questify/shared";
import { useState } from "react";
import { sessionLost } from "#src/lib/invitations.ts";
import { isTransientFailure, requestJson, type PostResult } from "#src/lib/post-json.ts";
import { useRequestKey } from "#src/lib/use-request-key.ts";

/**
 * The writes of an invitation page (T-409b): one at a time, each with an Idempotency-Key that a dropped answer keeps
 * (so the retry replays the first answer) and any other answer ends. A failed call shows its words; a lost session
 * goes to the sign-in page.
 */
export function useInvitationWrites(language: Language, textOf: (body: unknown) => string) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const request = useRequestKey();

  /** Shows what a failed answer says, or leaves for the sign-in page when the session is over. */
  const fail = (body: unknown): void => {
    if (sessionLost(body)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(textOf(body));
  };

  const write = async (
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<PostResult> => {
    setBusy(true);
    setProblem(null);
    const signature = `${method} ${path} ${JSON.stringify(body ?? null)}`;
    const result = await requestJson(method, path, body, {
      "idempotency-key": request.keyFor(signature),
    });
    if (!isTransientFailure(result)) {
      request.forget();
    }
    if (!result.ok) {
      fail(result.body);
    }
    setBusy(false);
    return result;
  };

  return { busy, problem, setProblem, fail, write };
}
