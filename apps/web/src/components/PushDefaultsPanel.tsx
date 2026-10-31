"use client";

import {
  PUSH_TOPICS,
  pushTopicsSchema,
  type Language,
  type MessageKey,
  type PushTopic,
  type PushTopics,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Switch } from "#src/ui/Field.tsx";
import { Rows, Section } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The topics as the app's Settings names them, so a player sees the same words the organizer chose from. */
const TOPIC_TITLE = {
  announcements: "pushTopic.announcements",
  rank: "pushTopic.rank",
  community: "pushTopic.community",
  reminders: "pushTopic.reminders",
} as const satisfies Record<PushTopic, MessageKey>;

/**
 * Which notification topics start on for the event's players (T-510, FR-1836): one switch per topic, saved as soon as it
 * moves. It decides only what a player who has not chosen the topic gets; a player's own choice always wins.
 */
export function PushDefaultsPanel({
  language,
  path,
}: Readonly<{ language: Language; path: string }>) {
  const t = useTranslator(language);
  const [topics, setTopics] = useState<PushTopics | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const fail = useCallback(
    (body: unknown) => {
      const code = errorCodeOf(body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      setProblem(describeProblem(body, language, t).text);
    },
    [language, t],
  );

  const load = useCallback(async () => {
    setProblem(null);
    const result = await requestJson("GET", path);
    const read = result.ok ? pushTopicsSchema.safeParse(result.body) : undefined;
    if (read?.success === true) setTopics(read.data);
    else fail(result.body);
  }, [path, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (topic: PushTopic, on: boolean) => {
    if (topics === null) return;
    const before = topics;
    setTopics({ ...before, [topic]: on });
    setBusy(true);
    setProblem(null);
    const result = await requestJson("PUT", path, { [topic]: on });
    setBusy(false);
    const stored = result.ok ? pushTopicsSchema.safeParse(result.body) : undefined;
    if (stored?.success === true) {
      setTopics(stored.data);
      return;
    }
    setTopics(before);
    fail(result.body);
  };

  return (
    <Section
      titleId="push-defaults-title"
      title={t("pushDefaults.title")}
      info={infoTip(t, "pushDefaults.hint")}
    >
      {topics === null ? (
        problem === null ? (
          <Muted>{t("common.loading")}</Muted>
        ) : (
          <Button variant="primary" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        )
      ) : (
        <Rows>
          {PUSH_TOPICS.map((topic) => (
            <li key={topic}>
              <Switch
                label={t(TOPIC_TITLE[topic])}
                checked={topics[topic]}
                disabled={busy}
                onChange={(changed) => void change(topic, changed.target.checked)}
              />
            </li>
          ))}
        </Rows>
      )}
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
    </Section>
  );
}
