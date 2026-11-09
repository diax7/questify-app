"use client";

import {
  formatEventTime,
  readinessSoonSchema,
  type Language,
  type ReadinessSoonEvent,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ReadinessCounts, ReadinessText } from "#src/components/ReadinessParts.tsx";
import styles from "#src/components/readiness.module.css";
import { nameIn } from "#src/lib/console.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { byUrgency } from "#src/lib/readiness.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { PanelGrid } from "#src/ui/Charts.tsx";
import { Section, Stack } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

/** One event: who it is, when it starts, how many items hold each status, and the items still open. */
function EventCard({
  language,
  event,
}: Readonly<{ language: Language; event: ReadinessSoonEvent }>) {
  const t = translatorFor(language);
  const { counts, items } = event.readiness;
  const open = byUrgency(items).filter((item) => item.status !== "done");
  return (
    <Section
      as="article"
      level={2}
      look="sub"
      title={
        <TextLink strong href={`/${language}/console/events/${event.id}`} dir="auto">
          {nameIn(event.name, language)}
        </TextLink>
      }
    >
      <Muted>
        <span dir="auto">{event.organizer.name}</span>
        {" · "}
        {t("console.readiness.starts", {
          date: formatEventTime(new Date(event.startsAt), event.timezone, language),
        })}
      </Muted>
      <ReadinessCounts language={language} counts={counts} />
      {open.length === 0 ? (
        <Badge tone="success">{t("console.readiness.ready")}</Badge>
      ) : (
        <ul className={styles.open}>
          {open.map((item) => (
            <li key={item.key}>
              <ReadinessText language={language} item={item} showStatus />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

type Read =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "ready"; events: readonly ReadinessSoonEvent[] }>;

/**
 * The console's readiness list (T-618, FR-1845): the events that start within 14 days and are not live yet, soonest
 * first, each with the checklist its owner reads and the items still open. Equal cards; the event's name opens its
 * console page. Read only; platform admins only.
 */
export function ConsoleReadiness({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [state, setState] = useState<Read>({ kind: "loading" });
  const load = useCallback(async () => {
    const result = await requestJson("GET", "/v1/admin/readiness");
    const parsed = result.ok ? readinessSoonSchema.safeParse(result.body) : undefined;
    setState(
      parsed?.success === true ? { kind: "ready", events: parsed.data.events } : { kind: "failed" },
    );
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Stack as="section" aria-labelledby="readiness-page-title">
      <PageHeader titleId="readiness-page-title" title={t("console.readiness.title")} />
      {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {state.kind === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("console.readiness.loadFailed")}{" "}
          <Button size="sm" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {state.kind === "ready" && state.events.length === 0 ? (
        <EmptyState>{t("console.readiness.empty")}</EmptyState>
      ) : null}
      {state.kind === "ready" && state.events.length > 0 ? (
        <PanelGrid>
          {state.events.map((event) => (
            <EventCard key={event.id} language={language} event={event} />
          ))}
        </PanelGrid>
      ) : null}
    </Stack>
  );
}
