"use client";
import { teamSponsorListSchema, type Language, type TeamSponsor } from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { Translate } from "#src/lib/language.ts";
import { isTransientFailure, requestJson, type PostResult } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import {
  questChoices,
  rewardChoices,
  sponsorIssueKey,
  type TagChoices,
} from "#src/lib/sponsors.ts";

export type SponsorsProps = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/** The words for a refused write: a field issue in the sponsor's own words, else the API's message. */
export function sponsorFailure(body: unknown, language: Language, t: Translate): string {
  const details = (body as { details?: { issue?: string } } | undefined)?.details;
  if (errorCodeOf(body) === "invalid_sponsor" && details?.issue !== undefined) {
    return t(sponsorIssueKey(details.issue));
  }
  return describeProblem(body, language, t).text;
}

/**
 * One event's sponsors for the dashboard: the sponsors with their tags (read again every 15 seconds), the quests,
 * categories and rewards a tag can name, and the writes. A write keeps its Idempotency-Key until it is answered.
 */
export function useSponsors({ language, organizerId, eventId }: SponsorsProps) {
  const t = useTranslator(language);
  const api = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [sponsors, setSponsors] = useState<TeamSponsor[] | null>(null);
  const [choices, setChoices] = useState<TagChoices>({ quest: [], category: [], reward: [] });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const scope = generation.current;
    const [list, quests, rewards] = await Promise.all([
      requestJson("GET", `${api}/sponsors`),
      requestJson("GET", `${api}/quests`),
      requestJson("GET", `${api}/rewards`),
    ]);
    if (scope !== generation.current) return;
    const parsed = list.ok ? teamSponsorListSchema.safeParse(list.body) : null;
    if (parsed?.success === true && quests.ok && rewards.ok) {
      setSponsors(parsed.data.sponsors);
      setChoices({
        ...questChoices(quests.body, language),
        reward: rewardChoices(rewards.body, language),
      });
      setProblem(null);
    } else setProblem(t("sponsors.page.loadFailed"));
  }, [api, language, t]);

  useEffect(() => {
    generation.current += 1;
    setSponsors(null);
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
    const result = await requestJson(method, `${api}${suffix}`, body, { "idempotency-key": key });
    if (!isTransientFailure(result)) keys.current.delete(operation);
    if (result.ok) await load();
    setBusy(false);
    return result;
  };

  return { sponsors, choices, problem, busy, load, write };
}
export type SponsorsModel = ReturnType<typeof useSponsors>;
