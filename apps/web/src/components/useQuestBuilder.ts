"use client";

import type { Language } from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import type { CategoryView } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";

type Method = "POST" | "PATCH" | "PUT" | "DELETE";

/** A change that waits for the person to confirm it, because the event is live (FR-1007). */
export type PendingChange = Readonly<{
  method: Method;
  path: string;
  body: Readonly<Record<string, unknown>>;
  options: SendOptions;
}>;

export type SendOptions = Readonly<{
  /** Runs after a success, before the reload. */
  after?: () => void;
  /** The Idempotency-Key of a create: one per submission, kept by the caller, reused on a resend. */
  key?: string;
}>;

export type BuilderEvent = Readonly<{ timezone: string; name: string; statusNow: string }>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
const FIELD_CODES = new Set(["invalid_quest", "invalid_category"]);

/** The words for a refusal: the field to fix for a builder 422, the API's own message otherwise. */
function problemText(body: unknown, language: Language): string {
  const t = translatorFor(language);
  const field = (body as { details?: { field?: unknown } } | undefined)?.details?.field;
  const code = errorCodeOf(body);
  if (code !== undefined && FIELD_CODES.has(code) && typeof field === "string") {
    return t(`quests.invalid.${field}` as "quests.invalid.title");
  }
  return describeProblem(body, language, t).text;
}

/**
 * The builder's data and requests. Creates carry the caller's Idempotency-Key, so a double tap or a retry never makes
 * two; a change the API holds for a live event's confirmation waits in `pending` until the person confirms, then goes
 * again with `confirm: true` and the same key.
 */
export function useQuestBuilder(language: Language, organizerId: string, eventId: string) {
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [categories, setCategories] = useState<readonly CategoryView[] | null>(null);
  const [focusQuestId, setFocusQuestId] = useState<string | null>(null);
  const [event, setEvent] = useState<BuilderEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const loaded = useRef(false);

  const failed = useCallback(
    (result: PostResult): boolean => {
      const code = errorCodeOf(result.body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return true;
      }
      if (!result.ok) {
        setProblem(problemText(result.body, language));
      }
      return !result.ok;
    },
    [language],
  );

  const reload = useCallback(async () => {
    const result = await requestJson("GET", `${base}/quests`);
    if (!failed(result)) {
      const view = result.body as { focusQuestId: string | null; categories: CategoryView[] };
      setFocusQuestId(view.focusQuestId);
      setCategories(view.categories);
    }
  }, [base, failed]);

  useEffect(() => {
    // Once per page, also under Strict Mode's double effect.
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}`).then((result) => {
      if (!failed(result)) {
        const view = (
          result.body as {
            event: {
              timezone: string;
              statusNow: string;
              name: { ar: string | null; en: string | null };
            };
          }
        ).event;
        const other = language === "ar" ? view.name.en : view.name.ar;
        setEvent({
          timezone: view.timezone,
          statusNow: view.statusNow,
          name: view.name[language] ?? other ?? "",
        });
        void reload();
      }
    });
  }, [organizerId, eventId, language, failed, reload]);

  const send = async (
    method: Method,
    path: string,
    body: Readonly<Record<string, unknown>>,
    options: SendOptions = {},
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    const headers: Record<string, string> =
      options.key === undefined ? {} : { "idempotency-key": options.key };
    const result = await requestJson(method, `${base}${path}`, body, headers);
    setBusy(false);
    if (errorCodeOf(result.body) === "confirm_required") {
      setPending({ method, path, body, options });
      return false;
    }
    if (failed(result)) {
      return false;
    }
    options.after?.();
    await reload();
    return true;
  };

  const confirmPending = async () => {
    if (pending === null) {
      return;
    }
    const change = pending;
    setPending(null);
    await send(change.method, change.path, { ...change.body, confirm: true }, change.options);
  };

  return {
    categories,
    focusQuestId,
    event,
    busy,
    problem,
    setProblem,
    pending,
    send,
    confirmPending,
    cancelPending: () => setPending(null),
  };
}
