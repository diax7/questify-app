"use client";
import type { AdminInvitationCampaign, Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { nameIn } from "#src/lib/console.ts";
import { INVITATIONS_API, isOpen, readQueue, waitingCount } from "#src/lib/console-invitations.ts";
import { invitationProblemText, riyadhTime } from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import styles from "#src/components/layout.module.css";

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
    <li className={styles.card} data-testid="queue-row" data-state={campaign.state}>
      <span className={styles.stack}>
        <a className={styles.textLink} href={`/${language}/console/invitations/${campaign.id}`}>
          <bdi dir="auto">{nameIn(campaign.event.name, language)}</bdi>
        </a>
        <span className={styles.muted}>
          <bdi dir="auto">{campaign.organizer.name}</bdi> ·{" "}
          {t("console.invCampaign.requestedAt", {
            time: riyadhTime(campaign.requestedAt, language),
          })}
        </span>
        {started ? (
          <span className={styles.muted}>
            {t("console.invCampaign.progress", {
              sent: campaign.counts.sent + campaign.counts.unknown,
              planned: campaign.counts.planned,
            })}
          </span>
        ) : null}
      </span>
      <span className={styles.badge}>{t(`invCampaign.state.${campaign.state}`)}</span>
    </li>
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
      <h2 className={styles.subtitle}>{title}</h2>
      {campaigns.length === 0 ? (
        <p className={styles.muted}>{t("console.invCampaign.empty")}</p>
      ) : (
        <ul className={styles.list}>
          {campaigns.map((campaign) => (
            <Row key={campaign.id} language={language} campaign={campaign} />
          ))}
        </ul>
      )}
    </>
  );
}

/** The console's invitation requests (T-409b, FR-738): the open ones first, then the latest closed ones. */
export function ConsoleInvitations({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const queue = useQueue(language);
  return (
    <section className={styles.stack} aria-labelledby="console-invitations-title">
      <h1 id="console-invitations-title" className={styles.title}>
        {t("console.invCampaign.title")}
      </h1>
      <p className={styles.muted}>{t("console.invCampaign.intro")}</p>
      {queue.kind === "loading" ? (
        <p role="status" className={styles.muted}>
          {t("common.loading")}
        </p>
      ) : null}
      {queue.kind === "failed" ? (
        <p role="alert" className={styles.alert}>
          {queue.text}
        </p>
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
    </section>
  );
}

/** The console home's link to the queue, with the number of requests waiting for a decision once it is read. */
export function ConsoleInvitationsLink({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    let current = true;
    void requestJson("GET", INVITATIONS_API).then((result) => {
      const campaigns = result.ok ? readQueue(result.body) : undefined;
      if (current && campaigns !== undefined) {
        setWaiting(waitingCount(campaigns));
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return (
    <p>
      <a className={styles.textLink} href={`/${language}/console/invitations`}>
        {waiting === 0
          ? t("console.invCampaign.title")
          : t("console.invCampaign.linkCount", { count: waiting })}
      </a>
    </p>
  );
}
