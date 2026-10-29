"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { nameFor, type EventView } from "#src/lib/events.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { STATUS_TONE } from "#src/lib/events.ts";
import { ButtonLink } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { TextLink } from "#src/ui/Text.tsx";
import { Card, CardList, Row, Stack } from "#src/ui/Section.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/**
 * An organizer's events (FR-1001): newest first, each with its status at this moment and its times in its own zone
 * (FR-1728). A draft says Questify activates it after payment (FR-1017). An editor limited to chosen events sees only
 * those; the API decides.
 */
export function EventsPanel({
  language,
  organizerId,
}: Readonly<{ language: Language; organizerId: string }>) {
  const t = translatorFor(language);
  const base = `/${language}/organizers/${organizerId}/events`;
  const [events, setEvents] = useState<readonly EventView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    // Once per page, also under Strict Mode's double effect.
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events`).then((result) => {
      const code = errorCodeOf(result.body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
      } else if (result.ok) {
        setEvents((result.body as { events: EventView[] }).events);
      } else {
        setProblem(describeProblem(result.body, language, t).text);
      }
    });
  }, [organizerId, language, t]);

  return (
    <Stack>
      <PageHeader
        titleId="events-title"
        title={t("events.title")}
        actions={
          <ButtonLink variant="primary" href={`${base}/new`}>
            {t("events.new")}
          </ButtonLink>
        }
      />
      {problem === null ? null : (
        <Notice role="alert" tone="danger">
          {problem}
        </Notice>
      )}
      {events === null ? (
        problem === null ? (
          <Muted>{t("common.loading")}</Muted>
        ) : null
      ) : events.length === 0 ? (
        <EmptyState>{t("events.none")}</EmptyState>
      ) : (
        <CardList>
          {events.map((event) => (
            <Card as="li" key={event.id}>
              <Row
                as="div"
                main={
                  <>
                    <TextLink strong href={`${base}/${event.id}`}>
                      {nameFor(event, language)}
                    </TextLink>
                    <Muted>
                      {formatEventTime(new Date(event.startsAt), event.timezone, language)}
                    </Muted>
                    {event.statusNow === "draft" ? <Muted>{t("events.draftNote")}</Muted> : null}
                  </>
                }
              >
                <Badge tone={STATUS_TONE[event.statusNow]}>
                  {t(`events.status.${event.statusNow}`)}
                </Badge>
              </Row>
            </Card>
          ))}
        </CardList>
      )}
    </Stack>
  );
}
