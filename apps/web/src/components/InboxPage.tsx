"use client";

import { inboxSchema, type Inbox, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { InboxTiles, WaitingCard } from "#src/components/InboxParts.tsx";
import { JoinRequestsPanel } from "#src/components/JoinRequestsPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { INBOX_ROWS } from "#src/lib/inbox.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { PanelGrid, WideCard } from "#src/ui/Charts.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, SubHeading } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/**
 * The event's counts, read when the page opens and again on request (after a join decision, or Try again). The last
 * good counts stay on screen while a new read runs; a failed read keeps them and says so.
 */
function useInboxCounts(language: Language, eventApi: string) {
  const [inbox, setInbox] = useState<Inbox | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const read = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/inbox`);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    const parsed = result.ok ? inboxSchema.safeParse(result.body) : undefined;
    if (parsed?.success === true) {
      setFailed(false);
      setInbox(parsed.data);
    } else {
      setFailed(true);
    }
  }, [language, eventApi]);
  useEffect(() => {
    void read();
  }, [read]);
  return { inbox, failed, read };
}

/**
 * Whether the join queue shows: the event takes requests or holds some. Once it has shown it stays for this visit, so
 * the result of Accept all is not taken away with the last request.
 */
function useQueueShown(inbox: Inbox | undefined): boolean {
  const takes =
    inbox !== undefined && (inbox.joinRequests.private || inbox.joinRequests.pending > 0);
  const [saw, setSaw] = useState(false);
  useEffect(() => {
    if (takes) {
      setSaw(true);
    }
  }, [takes]);
  return takes || saw;
}

type Where = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
}>;

/** The counts and the cards under them, once the counts are read. */
function InboxBody({
  where,
  inbox,
  read,
}: Readonly<{ where: Where; inbox: Inbox; read: () => Promise<void> }>) {
  const { language, organizerId, eventId } = where;
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const eventBase = `/${language}/organizers/${organizerId}/events/${eventId}`;
  const withRequests = useQueueShown(inbox);
  return (
    <>
      <SubHeading as="h2">{t("inbox.group.waiting")}</SubHeading>
      <InboxTiles
        language={language}
        inbox={inbox}
        eventBase={eventBase}
        withRequests={withRequests}
      />
      <PanelGrid>
        <WaitingCard
          language={language}
          eventApi={eventApi}
          eventBase={eventBase}
          kind="report_player"
          count={inbox.tickets.report_player}
          title="inbox.reported.title"
        />
        <WaitingCard
          language={language}
          eventApi={eventApi}
          eventBase={eventBase}
          kind="prize"
          count={inbox.tickets.prize}
          title="inbox.prizes.title"
        />
        {withRequests ? (
          <WideCard>
            <JoinRequestsPanel
              language={language}
              organizerId={organizerId}
              eventId={eventId}
              inbox={{
                rows: INBOX_ROWS,
                moreHref: `${eventBase}/players`,
                onChange: () => void read(),
              }}
            />
          </WideCard>
        ) : null}
      </PanelGrid>
    </>
  );
}

/**
 * The owner's Inbox (T-616, FR-1825): what waits for the team in one place. Counts by kind, each a link to the Help
 * desk list it counts (and to Submissions, Flagged activity and the join requests); the oldest reported players and
 * prize problems with a link to answer each; and the join requests with Accept, Decline and Accept all. Nothing is
 * stored here: every figure and row is the existing page's own read.
 */
export function InboxPage(where: Where) {
  const t = useTranslator(where.language);
  const { inbox, failed, read } = useInboxCounts(
    where.language,
    `/v1/organizers/${where.organizerId}/events/${where.eventId}`,
  );
  return (
    <Stack as="section" aria-labelledby="inbox-title">
      <PageHeader titleId="inbox-title" title={t("inbox.title")} />
      {failed ? (
        <Notice tone="danger" role="alert">
          {t("inbox.loadFailed")}{" "}
          <Button size="sm" onClick={() => void read()}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {inbox === undefined && !failed ? <Muted>{t("common.loading")}</Muted> : null}
      {inbox === undefined ? null : <InboxBody where={where} inbox={inbox} read={read} />}
    </Stack>
  );
}
