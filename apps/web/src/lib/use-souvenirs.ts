"use client";
import {
  souvenirListSchema,
  type Language,
  type SouvenirBody,
  type SouvenirList,
} from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";

export type SouvenirProps = { language: Language; organizerId: string; eventId: string };
function useCategories(api: string, language: Language) {
  const [choices, setChoices] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let ended = false;
    setChoices([]);
    void requestJson("GET", `${api}/quests`).then((result) => {
      if (ended || !result.ok) return;
      const categories = (
        result.body as
          | { categories?: { id: string; name: { ar: string | null; en: string | null } }[] }
          | undefined
      )?.categories;
      if (Array.isArray(categories))
        setChoices(
          categories.map((category) => ({
            id: category.id,
            name: category.name[language] ?? category.name.en ?? category.name.ar ?? "",
          })),
        );
    });
    return () => {
      ended = true;
    };
  }, [api, language]);
  return choices;
}

/** Discards earlier-scope reads and older polls; writes keep their retry key after a failed request. */
export function useSouvenirs({ language, organizerId, eventId }: SouvenirProps) {
  const t = useTranslator(language);
  const api = `/api/v1/organizers/${organizerId}/events/${eventId}`;
  const [list, setList] = useState<SouvenirList | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const categories = useCategories(api, language);
  const generation = useRef(0);
  const read = useRef(0);
  const writing = useRef(false);
  const keys = useRef(new Map<string, string>());
  const failed = useCallback(
    (body: unknown) => {
      const code = errorCodeOf(body);
      if (
        code === "forbidden" ||
        code === "not_found" ||
        code === "unauthenticated" ||
        code === "session_expired"
      ) {
        generation.current += 1;
        setList(null);
        setBusy(false);
        writing.current = false;
        keys.current.clear();
      }
      if (code === "unauthenticated" || code === "session_expired") {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      setProblem(
        body === undefined ? t("souvenir.loadFailed") : describeProblem(body, language, t).text,
      );
    },
    [language, t],
  );
  const load = useCallback(async () => {
    const scope = generation.current;
    const version = ++read.current;
    const result = await requestJson("GET", `${api}/souvenirs`);
    if (scope !== generation.current || version !== read.current) return;
    const parsed = result.ok ? souvenirListSchema.safeParse(result.body) : null;
    if (parsed?.success === true) {
      setList(parsed.data);
      setProblem(null);
    } else failed(result.body);
  }, [api, failed]);
  useEffect(() => {
    generation.current += 1;
    setList(null);
    setProblem(null);
    setBusy(false);
    writing.current = false;
    keys.current.clear();
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
  }, [api, load]);
  const mutate = async (
    method: "POST" | "PATCH" | "DELETE",
    suffix: string,
    body?: SouvenirBody | { targetIds: string[] },
  ) => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    read.current += 1;
    const scope = generation.current;
    const operation = JSON.stringify([method, suffix, body ?? null]);
    const key = keys.current.get(operation) ?? crypto.randomUUID();
    keys.current.set(operation, key);
    const result = await requestJson(method, `${api}/souvenirs${suffix}`, body, {
      "idempotency-key": key,
    });
    if (scope !== generation.current) return false;
    writing.current = false;
    setBusy(false);
    read.current += 1;
    const parsed = result.ok ? souvenirListSchema.safeParse(result.body) : null;
    if (parsed?.success !== true) {
      failed(result.body);
      return false;
    }
    keys.current.delete(operation);
    setList(parsed.data);
    setProblem(null);
    return true;
  };
  return { list, busy, problem, categories, load, mutate };
}
export type SouvenirModel = ReturnType<typeof useSouvenirs>;
