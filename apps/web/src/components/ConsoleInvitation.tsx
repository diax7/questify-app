"use client";
import type { AdminInvitationDetail, Language } from "@questify/shared";
import { ApproveForm, CloseForm } from "#src/components/ConsoleInvitationActions.tsx";
import {
  Counters,
  Facts,
  Messages,
  Names,
  Warnings,
} from "#src/components/ConsoleInvitationParts.tsx";
import { isOpen } from "#src/lib/console-invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useConsoleInvitation } from "#src/lib/use-console-invitation.ts";
import styles from "#src/components/layout.module.css";

type Model = ReturnType<typeof useConsoleInvitation>;

function Ready({
  language,
  detail,
  model,
}: Readonly<{ language: Language; detail: AdminInvitationDetail; model: Model }>) {
  const { campaign } = detail;
  return (
    <>
      <Facts language={language} detail={detail} />
      <Warnings language={language} detail={detail} />
      <Names language={language} detail={detail} />
      <Messages language={language} detail={detail} />
      {campaign.startedAt === null ? null : <Counters language={language} detail={detail} />}
      {campaign.state === "requested" ? (
        <ApproveForm
          language={language}
          detail={detail}
          busy={model.busy}
          approve={model.approve}
        />
      ) : null}
      {isOpen(campaign) ? (
        <CloseForm language={language} detail={detail} busy={model.busy} close={model.close} />
      ) : null}
    </>
  );
}

/**
 * One invitation request in the console (T-409b, FR-738): who asked and for what, the audience now, the event's names
 * with the name rule's verdicts, the exact text players get (frozen once approved), the exact counters, and Approve,
 * Refuse and Cancel. Anything that is not a request reads as "not found", as the API answers.
 */
export function ConsoleInvitation({
  language,
  campaignId,
}: Readonly<{ language: Language; campaignId: string }>) {
  const t = translatorFor(language);
  const model = useConsoleInvitation(language, campaignId);
  const { detail } = model;
  return (
    <section className={styles.stack} aria-labelledby="console-invitation-title">
      <p>
        <a className={styles.textLink} href={`/${language}/console/invitations`}>
          {t("console.invCampaign.back")}
        </a>
      </p>
      <h1 id="console-invitation-title" className={styles.title}>
        {t("console.invCampaign.detailTitle")}
      </h1>
      {model.problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {model.problem}
        </p>
      )}
      {model.notice === null ? null : (
        <p role="status" className={styles.notice}>
          {model.notice}
        </p>
      )}
      {detail === "loading" ? (
        <p role="status" className={styles.muted}>
          {t("common.loading")}
        </p>
      ) : null}
      {detail === "missing" ? (
        <p role="alert" className={styles.alert}>
          {t("console.invCampaign.notFound")}
        </p>
      ) : null}
      {typeof detail === "string" ? null : (
        <Ready language={language} detail={detail} model={model} />
      )}
    </section>
  );
}
