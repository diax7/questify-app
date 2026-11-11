"use client";

import {
  consoleFeatureRequestsSchema,
  formatEventTime,
  type ConsoleFeatureRequest,
  type ConsoleFeatureRequests as Page,
  type Language,
} from "@questify/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { addonName } from "#src/lib/activation.ts";
import { nameIn } from "#src/lib/console.ts";
import { SAUDI_ZONE } from "#src/lib/console-questify.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Card, CardList, Stack, SubHeading } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const BASE = "/v1/admin/feature-requests";

/** The page after `next`, or undefined when the answer is not the expected shape. */
async function readPage(next: Page["next"]): Promise<Page | undefined> {
  const query =
    next === null
      ? ""
      : `?afterAt=${encodeURIComponent(next.afterAt)}&afterId=${encodeURIComponent(next.afterId)}`;
  const result = await requestJson("GET", `${BASE}${query}`);
  const parsed = consoleFeatureRequestsSchema.safeParse(result.body);
  return result.ok && parsed.success ? parsed.data : undefined;
}

/**
 * The console home's Ask Questify requests (T-711b, FR-1827), oldest first: Allow is the add-on unlock (it closes the
 * request), Decline answers no; either takes the row off the list. Business names only.
 */
export function ConsoleFeatureRequests({ language }: Readonly<{ language: Language }>) {
  // One translator per language, so the first read below runs once, not on every render.
  const t = useMemo(() => translatorFor(language), [language]);
  const [rows, setRows] = useState<ConsoleFeatureRequest[] | null>(null);
  const [next, setNext] = useState<Page["next"]>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(
    async (after: Page["next"]) => {
      const page = await readPage(after);
      if (page === undefined) {
        setProblem(t("error.network"));
        return;
      }
      setRows((before) => [...(after === null ? [] : (before ?? [])), ...page.requests]);
      setNext(page.next);
    },
    [t],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const decide = async (row: ConsoleFeatureRequest, allow: boolean) => {
    if (busy !== null) return;
    setBusy(row.id);
    setProblem(null);
    const result = allow
      ? await requestJson("PUT", `/v1/admin/events/${row.eventId}/addons/${row.feature}`)
      : await requestJson("POST", `${BASE}/${row.id}/decline`, {});
    setBusy(null);
    if (!result.ok) {
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    setRows((before) => (before ?? []).filter((one) => one.id !== row.id));
  };

  return (
    <Stack as="section" aria-labelledby="feature-requests-title">
      <SubHeading as="h2" id="feature-requests-title">
        {t("console.featureRequests.title")}
      </SubHeading>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {rows === null ? (
        <Muted role="status">{t("common.loading")}</Muted>
      ) : rows.length === 0 ? (
        <EmptyState>{t("console.featureRequests.empty")}</EmptyState>
      ) : (
        <CardList>
          {rows.map((row) => (
            <Card as="li" key={row.id}>
              <TextLink strong href={`/${language}/console/events/${row.eventId}`}>
                {nameIn(row.event, language)}
              </TextLink>
              <Muted>
                {row.organizer} · {addonName(row.feature, t)} ·{" "}
                {t("console.requestedAt", {
                  date: formatEventTime(new Date(row.requestedAt), SAUDI_ZONE, language),
                })}
              </Muted>
              <Button
                variant="primary"
                disabled={busy !== null}
                aria-busy={busy === row.id}
                onClick={() => void decide(row, true)}
              >
                {t("console.featureRequests.allow")}
              </Button>
              <Button
                variant="secondary"
                disabled={busy !== null}
                aria-busy={busy === row.id}
                onClick={() => void decide(row, false)}
              >
                {t("console.featureRequests.decline")}
              </Button>
            </Card>
          ))}
        </CardList>
      )}
      {next === null ? null : (
        <Button variant="secondary" onClick={() => void load(next)}>
          {t("console.featureRequests.more")}
        </Button>
      )}
    </Stack>
  );
}
