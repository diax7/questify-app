"use client";
import { teamMapListSchema, type Language, type TeamMap } from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { Translate } from "#src/lib/language.ts";
import { mapIssueKey } from "#src/lib/maps.ts";
import { isTransientFailure, requestJson, type PostResult } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";

export type MapsProps = Readonly<{ language: Language; organizerId: string; eventId: string }>;
export type QuestChoice = Readonly<{ id: string; title: string }>;

type QuestsBody = {
  categories?: { quests?: { id: string; title: { ar?: string; en?: string } }[] }[];
};

function questChoices(body: unknown, language: Language): QuestChoice[] {
  const categories = (body as QuestsBody | undefined)?.categories ?? [];
  return categories.flatMap((category) =>
    (category.quests ?? []).map((quest) => ({
      id: quest.id,
      title: quest.title[language] ?? quest.title.en ?? quest.title.ar ?? "",
    })),
  );
}

/** The words for a refused write: a field issue in the map's own words, else the API's message. */
export function mapFailure(body: unknown, language: Language, t: Translate): string {
  const details = (body as { details?: { issue?: string } } | undefined)?.details;
  if (errorCodeOf(body) === "invalid_map" && details?.issue !== undefined) {
    return t(mapIssueKey(details.issue));
  }
  return describeProblem(body, language, t).text;
}

/**
 * One event's maps for the dashboard: the maps with their pins (read again every 15 seconds) and the quests a pin can
 * name, and the writes. A write keeps its Idempotency-Key until it is answered.
 */
export function useMaps({ language, organizerId, eventId }: MapsProps) {
  const t = useTranslator(language);
  const api = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [maps, setMaps] = useState<TeamMap[] | null>(null);
  const [quests, setQuests] = useState<QuestChoice[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const scope = generation.current;
    const [list, questList] = await Promise.all([
      requestJson("GET", `${api}/maps`),
      requestJson("GET", `${api}/quests`),
    ]);
    if (scope !== generation.current) return;
    const parsed = list.ok ? teamMapListSchema.safeParse(list.body) : null;
    if (parsed?.success === true && questList.ok) {
      setMaps(parsed.data.maps);
      setQuests(questChoices(questList.body, language));
      setProblem(null);
    } else setProblem(t("maps.page.loadFailed"));
  }, [api, language, t]);

  useEffect(() => {
    generation.current += 1;
    setMaps(null);
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
    const result = await requestJson(method, `${api}/maps${suffix}`, body, {
      "idempotency-key": key,
    });
    if (!isTransientFailure(result)) keys.current.delete(operation);
    if (result.ok) await load();
    setBusy(false);
    return result;
  };

  return { maps, quests, problem, busy, load, write };
}
export type MapsModel = ReturnType<typeof useMaps>;
