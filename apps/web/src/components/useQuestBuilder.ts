"use client";

import { parseComposedConfig, type Language } from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import {
  builderEventOf,
  problemText,
  sendHeaders,
  type BuilderEvent,
} from "#src/lib/quest-builder.ts";
import { questItemsOf, type QuestItem } from "#src/lib/quest-items.ts";
import type { CategoryView } from "#src/lib/quests.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";

export type { BuilderEvent };

type Method = "POST" | "PATCH" | "PUT" | "DELETE";

/** A change that waits for the person to confirm it, because the event is live (FR-1007). */
export type PendingChange = Readonly<{
  method: Method;
  path: string;
  body: Readonly<Record<string, unknown>>;
  options: SendOptions;
}>;

export type SendOptions = Readonly<{
  /** Runs after a success, once the list has been read again. */
  after?: () => void;
  /** The Idempotency-Key of a create: one per submission, kept by the caller, reused on a resend. */
  key?: string;
}>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The platform's location switch (ADR-208); without an answer the type stays hidden and the rest works. */
function useLocationQuestsOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void requestJson("GET", "/v1/config").then((result) => {
      const parsed = result.ok ? parseComposedConfig(result.body) : undefined;
      setOn(parsed?.ok === true && parsed.config.features["locationQuests"]?.enabled === true);
    });
  }, []);
  return on;
}

/**
 * The builder's data and requests. Creates carry the caller's Idempotency-Key, so a double tap or a retry never makes
 * two; a change the API holds for a live event's confirmation waits in `pending` until the person confirms, then goes
 * again with `confirm: true` and the same key.
 */
export function useQuestBuilder(language: Language, organizerId: string, eventId: string) {
  const t = useTranslator(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [categories, setCategories] = useState<readonly CategoryView[] | null>(null);
  const [items, setItems] = useState<readonly QuestItem[]>([]);
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
        setProblem(problemText(result.body, language, t));
      }
      return !result.ok;
    },
    [language, t],
  );

  const reload = useCallback(async () => {
    // Both reads at once; without the item picker's choices (T-304d) it offers none and the rest works.
    const read = (path: string) => requestJson("GET", `${base}${path}`);
    const [result, listed] = await Promise.all([read("/quests"), read("/quest-items")]);
    if (!failed(result)) {
      const view = result.body as { focusQuestId: string | null; categories: CategoryView[] };
      setFocusQuestId(view.focusQuestId);
      setCategories(view.categories);
    }
    setItems((listed.ok ? questItemsOf(listed.body) : undefined) ?? []);
  }, [base, failed]);

  useEffect(() => {
    // Once per page, also under Strict Mode's double effect.
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}`).then((result) => {
      if (!failed(result)) {
        setEvent(builderEventOf(result.body, language));
        void reload();
      }
    });
  }, [organizerId, eventId, language, failed, reload]);

  const locationQuestsOn = useLocationQuestsOn();

  const send = async (
    method: Method,
    path: string,
    body: Readonly<Record<string, unknown>>,
    options: SendOptions = {},
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson(method, `${base}${path}`, body, sendHeaders(options.key));
    const confirming = errorCodeOf(result.body) === "confirm_required";
    if (confirming) setPending({ method, path, body, options });
    const saved = !confirming && !failed(result);
    if (saved) {
      // The list is read again before the form closes, so what the person opens next shows what was just saved.
      await reload();
      options.after?.();
    }
    setBusy(false);
    return saved;
  };

  /** Reads a path of the builder's API (the hint's count); undefined, with the problem shown, when it fails. */
  const read = async (path: string): Promise<unknown> => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson("GET", `${base}${path}`);
    setBusy(false);
    return failed(result) ? undefined : result.body;
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
    items,
    focusQuestId,
    event,
    locationQuestsOn,
    busy,
    problem,
    setProblem,
    pending,
    send,
    read,
    reload,
    confirmPending,
    cancelPending: () => setPending(null),
  };
}
