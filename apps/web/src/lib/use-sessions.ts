"use client";
import {
  teamSessionListSchema,
  type Language,
  type SessionWindow,
  type TeamSession,
} from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { Translate } from "#src/lib/language.ts";
import { isTransientFailure, requestJson, type PostResult } from "#src/lib/post-json.ts";
import { sessionIssueKey } from "#src/lib/sessions.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";

export type SessionsProps = Readonly<{ language: Language; organizerId: string; eventId: string }>;
export type QuestChoice = Readonly<{ id: string; title: string }>;
export type EventFrame = Readonly<{ zone: string; window: SessionWindow }>;

type Frame = Readonly<{ event: EventFrame; quests: QuestChoice[] }>;

type EventBody = {
  event?: { timezone?: string; startsAt?: string | null; endsAt?: string | null };
};
type QuestsBody = {
  categories?: { quests?: { id: string; title: { ar?: string; en?: string } }[] }[];
};

function eventFrame(body: unknown): EventFrame | undefined {
  const view = (body as EventBody | undefined)?.event;
  if (typeof view?.timezone !== "string") return undefined;
  return {
    zone: view.timezone,
    window: { startsAt: view.startsAt ?? null, endsAt: view.endsAt ?? null },
  };
}

function questChoices(body: unknown, language: Language): QuestChoice[] {
  const categories = (body as QuestsBody | undefined)?.categories ?? [];
  return categories.flatMap((category) =>
    (category.quests ?? []).map((quest) => ({
      id: quest.id,
      title: quest.title[language] ?? quest.title.en ?? quest.title.ar ?? "",
    })),
  );
}

async function readFrame(api: string, language: Language): Promise<Frame | undefined> {
  const [event, quests] = await Promise.all([
    requestJson("GET", api),
    requestJson("GET", `${api}/quests`),
  ]);
  const frame = event.ok ? eventFrame(event.body) : undefined;
  return frame === undefined
    ? undefined
    : { event: frame, quests: questChoices(quests.body, language) };
}

/** The words for a refused write: a field issue in the session's own words, else the API's message. */
export function sessionFailure(body: unknown, language: Language, t: Translate): string {
  const details = (body as { details?: { issue?: string } } | undefined)?.details;
  if (errorCodeOf(body) === "invalid_session" && details?.issue !== undefined) {
    return t(sessionIssueKey(details.issue));
  }
  return describeProblem(body, language, t).text;
}

/**
 * One event's agenda for the dashboard: the sessions with their numbers (read again every 15 seconds), the event's zone
 * and dates, the quests a session can link to, and the writes. A write keeps its Idempotency-Key until it is answered.
 */
export function useSessions({ language, organizerId, eventId }: SessionsProps) {
  const t = useTranslator(language);
  const api = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [sessions, setSessions] = useState<TeamSession[] | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const scope = generation.current;
    const [list, read] = await Promise.all([
      requestJson("GET", `${api}/sessions`),
      readFrame(api, language),
    ]);
    if (scope !== generation.current) return;
    const parsed = list.ok ? teamSessionListSchema.safeParse(list.body) : null;
    if (parsed?.success === true && read !== undefined) {
      setSessions(parsed.data.sessions);
      setFrame(read);
      setProblem(null);
    } else setProblem(t("sessions.page.loadFailed"));
  }, [api, language, t]);

  useEffect(() => {
    generation.current += 1;
    setSessions(null);
    keys.current.clear();
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
  }, [load]);

  const write = async (
    method: "POST" | "PUT" | "DELETE",
    suffix: string,
    body?: unknown,
  ): Promise<PostResult> => {
    setBusy(true);
    const operation = JSON.stringify([method, suffix, body ?? null]);
    const key = keys.current.get(operation) ?? crypto.randomUUID();
    keys.current.set(operation, key);
    const result = await requestJson(method, `${api}/sessions${suffix}`, body, {
      "idempotency-key": key,
    });
    if (!isTransientFailure(result)) keys.current.delete(operation);
    if (result.ok) await load();
    setBusy(false);
    return result;
  };

  return { sessions, frame, problem, busy, load, write };
}
export type SessionsModel = ReturnType<typeof useSessions>;
