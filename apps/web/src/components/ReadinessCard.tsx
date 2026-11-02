"use client";

import { readinessSchema, type Language, type Readiness } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ReadinessCounts, ReadinessItems } from "#src/components/ReadinessParts.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { byUrgency } from "#src/lib/readiness.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Section } from "#src/ui/Section.tsx";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/** The checklist is for the time before go-live: a draft or a scheduled event. */
const BEFORE_GO_LIVE: ReadonlySet<Readiness["status"]> = new Set(["draft", "scheduled"]);

/** The event's checklist, read when the card opens and again on Try again; a failed read keeps the last good one. */
function useReadiness(organizerId: string, eventId: string) {
  const [readiness, setReadiness] = useState<Readiness | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const read = useCallback(async () => {
    const result = await requestJson(
      "GET",
      `/v1/organizers/${organizerId}/events/${eventId}/readiness`,
    );
    const parsed = result.ok ? readinessSchema.safeParse(result.body) : undefined;
    if (parsed?.success === true) {
      setFailed(false);
      setReadiness(parsed.data);
    } else {
      setFailed(true);
    }
  }, [organizerId, eventId]);
  useEffect(() => {
    void read();
  }, [read]);
  return { readiness, failed, read };
}

/**
 * The go-live checklist on the event's Overview and at the end of the guided setup (T-618, FR-1845): how many items are
 * ready, to check and needed, and every item with what it reads and a link to the page that fixes it, the ones that
 * need attention first. It only reads: nothing here changes the event, blocks a request for activation or activates.
 * Hidden until the read answers, and once the event is live, ended or archived.
 */
export function ReadinessCard({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const { readiness, failed, read } = useReadiness(organizerId, eventId);
  if (readiness === undefined && !failed) {
    return null;
  }
  if (readiness !== undefined && !BEFORE_GO_LIVE.has(readiness.status)) {
    return null;
  }
  return (
    <Section titleId="readiness-title" title={t("readiness.title")}>
      {failed ? (
        <Notice tone="danger" role="alert">
          {t("readiness.loadFailed")}{" "}
          <Button size="sm" onClick={() => void read()}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {readiness === undefined ? null : (
        <>
          <ReadinessCounts language={language} counts={readiness.counts} />
          <ReadinessItems
            language={language}
            items={byUrgency(readiness.items)}
            eventBase={`/${language}/organizers/${organizerId}/events/${eventId}`}
          />
        </>
      )}
    </Section>
  );
}
