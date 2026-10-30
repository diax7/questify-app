"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useEffect, useState, type FormEvent } from "react";
import { nameIn, readQueue, type QueueItem } from "#src/lib/console.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Stack } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

/** The console's activation queue, oldest first, and a way to open any event by its join code (FR-1021). */
export function ConsoleQueue({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    void (async () => {
      const result = await requestJson("GET", "/v1/admin/activation-requests");
      const rows = result.ok ? readQueue(result.body) : undefined;
      if (rows === undefined) {
        setProblem(describeProblem(result.body, language, translatorFor(language)).text);
        return;
      }
      setQueue(rows);
    })();
  }, [language]);

  const lookup = async (submitted: FormEvent) => {
    submitted.preventDefault();
    const trimmed = code.trim();
    if (!/^[A-Za-z0-9]{4,12}$/.test(trimmed)) {
      setProblem(t("console.notFound"));
      return;
    }
    const result = await requestJson("GET", `/v1/admin/events?code=${trimmed}`);
    const eventId = (result.body as { eventId?: unknown } | undefined)?.eventId;
    if (!result.ok || typeof eventId !== "string") {
      setProblem(t("console.notFound"));
      return;
    }
    window.location.assign(`/${language}/console/events/${eventId}`);
  };

  return (
    <Stack as="section" aria-labelledby="queue-title">
      <PageHeader titleId="queue-title" title={t("console.queue")} />
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      <Form card onSubmit={(submitted) => void lookup(submitted)}>
        <Field label={t("console.lookup")}>
          <Input
            dir="ltr"
            value={code}
            maxLength={12}
            autoComplete="off"
            onChange={(changed) => setCode(changed.target.value)}
          />
        </Field>
        <Button variant="primary" type="submit">
          {t("console.open")}
        </Button>
      </Form>
      {queue === null ? (
        problem === null ? (
          <Muted>{t("common.loading")}</Muted>
        ) : null
      ) : queue.length === 0 ? (
        <EmptyState>{t("console.queueEmpty")}</EmptyState>
      ) : (
        <CardList>
          {queue.map((item) => (
            <Card as="li" key={item.eventId}>
              <TextLink strong href={`/${language}/console/events/${item.eventId}`}>
                {nameIn(item.name, language)}
              </TextLink>
              <Muted>
                {item.organizer} ·{" "}
                {t("console.requestedAt", {
                  date: formatEventTime(new Date(item.requestedAt), item.timezone, language),
                })}
              </Muted>
            </Card>
          ))}
        </CardList>
      )}
    </Stack>
  );
}
