"use client";
import type { AdminInvitationCampaign, Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { nameIn } from "#src/lib/console.ts";
import { INVITATIONS_API, isOpen, readQueue, waitingCount } from "#src/lib/console-invitations.ts";
import { invitationProblemText, riyadhTime } from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { NavItem } from "#src/ui/Nav.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Stack, SubHeading } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

type Queue =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; text: string }>
  | Readonly<{ kind: "ready"; campaigns: readonly AdminInvitationCampaign[] }>;

/** The queue, read once; `failed` carries the words for what went wrong. */
function useQueue(language: Language): Queue {
  const [queue, setQueue] = useState<Queue>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    void requestJson("GET", INVITATIONS_API).then((result) => {
      const campaigns = result.ok ? readQueue(result.body) : undefined;
      if (!current) {
        return;
      }
      const t = translatorFor(language);
      setQueue(
        campaigns === undefined
          ? { kind: "failed", text: invitationProblemText(result.body, language, t) }
          : { kind: "ready", campaigns },
      );
    });
    return () => {
      current = false;
    };
  }, [language]);
  return queue;
}

function Row({
  language,
  campaign,
}: Readonly<{ language: Language; campaign: AdminInvitationCampaign }>) {
  const t = translatorFor(language);
  const started = campaign.startedAt !== null;
  return (
    <Card as="li" data-testid="queue-row" data-state={campaign.state}>
      <>
        <TextLink href={`/${language}/console/invitations/${campaign.id}`}>
          <bdi dir="auto">{nameIn(campaign.event.name, language)}</bdi>
        </TextLink>
        <Muted as="span">
          <bdi dir="auto">{campaign.organizer.name}</bdi> ·{" "}
          {t("console.invCampaign.requestedAt", {
            time: riyadhTime(campaign.requestedAt, language),
          })}
        </Muted>
        {started ? (
          <Muted as="span">
            {t("console.invCampaign.progress", {
              sent: campaign.counts.sent + campaign.counts.unknown,
              planned: campaign.counts.planned,
            })}
          </Muted>
        ) : null}
      </>
      <Badge>{t(`invCampaign.state.${campaign.state}`)}</Badge>
    </Card>
  );
}

function Group({
  language,
  title,
  campaigns,
}: Readonly<{
  language: Language;
  title: string;
  campaigns: readonly AdminInvitationCampaign[];
}>) {
  const t = translatorFor(language);
  return (
    <>
      <SubHeading as="h2">{title}</SubHeading>
      {campaigns.length === 0 ? (
        <Muted>{t("console.invCampaign.empty")}</Muted>
      ) : (
        <CardList>
          {campaigns.map((campaign) => (
            <Row key={campaign.id} language={language} campaign={campaign} />
          ))}
        </CardList>
      )}
    </>
  );
}

/** The console's invitation requests (T-409b, FR-738): the open ones first, then the latest closed ones. */
export function ConsoleInvitations({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const queue = useQueue(language);
  return (
    <Stack as="section" aria-labelledby="console-invitations-title">
      <PageHeader titleId="console-invitations-title" title={t("console.invCampaign.title")} />
      {queue.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {queue.kind === "failed" ? (
        <Notice tone="danger" role="alert">
          {queue.text}
        </Notice>
      ) : null}
      {queue.kind === "ready" ? (
        <>
          <Group
            language={language}
            title={t("console.invCampaign.open")}
            campaigns={queue.campaigns.filter(isOpen)}
          />
          <Group
            language={language}
            title={t("console.invCampaign.closed")}
            campaigns={queue.campaigns.filter((one) => !isOpen(one))}
          />
        </>
      ) : null}
    </Stack>
  );
}

/** This page's item in the console's navigation, with the number of requests waiting. */
export function ConsoleInvitationsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (current) {
      return;
    }
    let alive = true;
    void requestJson("GET", INVITATIONS_API).then((result) => {
      const campaigns = result.ok ? readQueue(result.body) : undefined;
      if (alive && campaigns !== undefined) {
        setWaiting(waitingCount(campaigns));
      }
    });
    return () => {
      alive = false;
    };
  }, [current]);
  return (
    <NavItem href={`/${language}/console/invitations`} icon="mail" current={current}>
      {waiting === 0
        ? t("console.invCampaign.title")
        : t("console.invCampaign.linkCount", { count: waiting })}
    </NavItem>
  );
}
