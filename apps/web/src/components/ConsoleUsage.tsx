"use client";

import type { Language, UsageEvents, UsageOrganizer } from "@questify/shared";
import { useEffect, useState } from "react";
import { problemOf } from "#src/components/PlayerAwards.tsx";
import { nameIn } from "#src/lib/console.ts";
import {
  USAGE_API,
  readUsageEvents,
  readUsageOrganizers,
  usageEventsPath,
} from "#src/lib/console-usage.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import {
  Card,
  CardList,
  FactList,
  Row,
  Rows,
  Stack,
  SubHeading,
  Toolbar,
} from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type Read<T> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; body: unknown }>
  | Readonly<{ kind: "ready"; value: T }>;

/** One read of the API, shown as loading, failed (the answer, or "network") or ready once the shape is checked. */
function useRead<T>(path: string, read: (body: unknown) => T | undefined): Read<T> {
  const [state, setState] = useState<Read<T>>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    void requestJson("GET", path).then((result) => {
      const value = result.ok ? read(result.body) : undefined;
      if (current) {
        setState(
          value === undefined
            ? { kind: "failed", body: result.body ?? "network" }
            : { kind: "ready", value },
        );
      }
    });
    return () => {
      current = false;
    };
  }, [path, read]);
  return state;
}

function Problem({ language, body }: Readonly<{ language: Language; body: unknown }>) {
  const t = translatorFor(language);
  return (
    <Notice tone="danger" role="alert">
      {body === "network" ? t("join.network") : problemOf(body, language, t)}
    </Notice>
  );
}

function Events({ language, usage }: Readonly<{ language: Language; usage: UsageEvents }>) {
  const t = translatorFor(language);
  if (usage.events.length === 0) {
    return <Muted>{t("console.usage.noEvents")}</Muted>;
  }
  return (
    <Rows>
      {usage.events.map((event) => (
        <Row
          key={event.id}
          main={
            <>
              <span dir="auto">{nameIn(event.name, language)}</span>{" "}
              <Badge>{t(`events.status.${event.status}`)}</Badge>
            </>
          }
        >
          <Muted as="span">
            {t("console.usage.eventFigures", {
              players: event.players,
              invitations: event.invitationsSent,
              alerts: event.alertEmails,
            })}
          </Muted>
        </Row>
      ))}
    </Rows>
  );
}

/** An organizer's events, read when the card opens. */
function OrganizerEvents({
  language,
  organizerId,
}: Readonly<{ language: Language; organizerId: string }>) {
  const t = translatorFor(language);
  const state = useRead(usageEventsPath(organizerId), readUsageEvents);
  return (
    <div id={`usage-${organizerId}`} data-testid="usage-events">
      {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {state.kind === "failed" ? <Problem language={language} body={state.body} /> : null}
      {state.kind === "ready" ? <Events language={language} usage={state.value} /> : null}
    </div>
  );
}

function OrganizerCard({
  language,
  organizer,
}: Readonly<{ language: Language; organizer: UsageOrganizer }>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState(false);
  return (
    <Card as="li" data-testid="usage-organizer">
      <Stack>
        <SubHeading as="h2">
          <span dir="auto">{organizer.name}</span>
        </SubHeading>
        <FactList label={organizer.name}>
          <dt>{t("console.usage.events")}</dt>
          <dd>{organizer.events}</dd>
          <dt>{t("console.usage.players")}</dt>
          <dd>{organizer.players}</dd>
          <dt>{t("console.usage.invitations")}</dt>
          <dd>{organizer.invitationsSent}</dd>
          <dt>{t("console.usage.alerts")}</dt>
          <dd>{organizer.alertEmails}</dd>
        </FactList>
        <Toolbar>
          <Button
            aria-expanded={open}
            aria-controls={`usage-${organizer.id}`}
            onClick={() => setOpen(!open)}
          >
            {open ? t("console.usage.hide") : t("console.usage.show")}
          </Button>
        </Toolbar>
        {open ? <OrganizerEvents language={language} organizerId={organizer.id} /> : null}
      </Stack>
    </Card>
  );
}

/**
 * The console's Usage view (T-609, FR-1730, ADR-394): the 100 organizers created last, each with its events, players,
 * invitations sent and alert emails sent, and its events with the same figures when the card opens. Read only, counts
 * only. Login SMS, promotional email, push volume and storage are not metered yet (Q-361).
 */
export function ConsoleUsage({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const list = useRead(USAGE_API, readUsageOrganizers);
  return (
    <Stack as="section" aria-labelledby="console-usage-title">
      <PageHeader
        titleId="console-usage-title"
        title={t("console.usage.title")}
        info={infoTip(t, "console.usage.intro")}
      />
      {list.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {list.kind === "failed" ? <Problem language={language} body={list.body} /> : null}
      {list.kind === "ready" && list.value.length === 0 ? (
        <Muted>{t("console.usage.empty")}</Muted>
      ) : null}
      {list.kind === "ready" && list.value.length > 0 ? (
        <CardList>
          {list.value.map((organizer) => (
            <OrganizerCard key={organizer.id} language={language} organizer={organizer} />
          ))}
        </CardList>
      ) : null}
    </Stack>
  );
}
