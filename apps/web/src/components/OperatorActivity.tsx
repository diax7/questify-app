"use client";

import {
  OPERATOR_RECENT_FIRST,
  operatorActivitySchema,
  type Language,
  type OperatorActivity as Activity,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ActivityTiles, OperatorRows, RecentCard } from "#src/components/OperatorActivityParts.tsx";
import { StaffBriefing } from "#src/components/StaffBriefing.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { PanelGrid, WideCard } from "#src/ui/Charts.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { SubHeading } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
/** How often the open page reads again, in milliseconds. */
const REFRESH_MS = 30_000;

/**
 * The event's operator activity, read when the page opens, every 30 seconds while it stays open, and on request (a new
 * page size, a sent briefing, Try again). The last good answer stays on screen while a new read runs; a failed read
 * keeps it and says so.
 */
function useActivity(language: Language, eventApi: string, recent: number) {
  const [activity, setActivity] = useState<Activity | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const read = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/operators/activity?recent=${recent}`);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    const parsed = result.ok ? operatorActivitySchema.safeParse(result.body) : undefined;
    if (parsed?.success === true) {
      setFailed(false);
      setActivity(parsed.data);
    } else {
      setFailed(true);
    }
  }, [language, eventApi, recent]);
  useEffect(() => {
    void read();
    const timer = window.setInterval(() => void read(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [read]);
  return { activity, failed, read };
}

/**
 * What each operator did today and last (T-617, FR-1844): five tiles for the event, a card per operator with the day's
 * numbers, their stations and how long ago they last acted (quiet from 30 minutes), the latest actions, and the staff
 * briefing, a message that reaches the event's operators only. Usernames and counts: never a player an operator served.
 * An event with no operators shows none of it (the page below says so).
 */
export function OperatorActivity({
  language,
  organizerId,
  eventId,
}: Readonly<{ language: Language; organizerId: string; eventId: string }>) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [limit, setLimit] = useState(OPERATOR_RECENT_FIRST);
  const { activity, failed, read } = useActivity(language, eventApi, limit);
  if (activity === undefined && !failed) {
    return null;
  }
  if (activity !== undefined && activity.operators.length === 0) {
    return null;
  }
  return (
    <>
      <SubHeading as="h2">{t("operatorActivity.title")}</SubHeading>
      {failed ? (
        <Notice tone="danger" role="alert">
          {t("operatorActivity.loadFailed")}{" "}
          <Button size="sm" onClick={() => void read()}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {activity === undefined ? null : (
        <>
          <ActivityTiles language={language} rows={activity.operators} asOf={activity.asOf} />
          <PanelGrid>
            <WideCard>
              <OperatorRows language={language} rows={activity.operators} asOf={activity.asOf} />
            </WideCard>
            <RecentCard
              language={language}
              recent={activity.recent}
              limit={limit}
              more={setLimit}
            />
            <StaffBriefing
              language={language}
              eventApi={eventApi}
              reachable={activity.reachable}
              briefings={activity.briefings}
              sent={read}
            />
          </PanelGrid>
        </>
      )}
    </>
  );
}
