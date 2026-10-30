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
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";

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
    <Stack as="section" aria-labelledby="console-invitation-title">
      <PageHeader
        titleId="console-invitation-title"
        title={t("console.invCampaign.detailTitle")}
        back={{ href: `/${language}/console/invitations`, label: t("console.invCampaign.back") }}
      />
      {model.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {model.problem}
        </Notice>
      )}
      {model.notice === null ? null : (
        <Notice tone="info" role="status">
          {model.notice}
        </Notice>
      )}
      {detail === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {detail === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("console.invCampaign.loadFailed")}
        </Notice>
      ) : null}
      {detail === "missing" ? (
        <Notice tone="danger" role="alert">
          {t("console.invCampaign.notFound")}
        </Notice>
      ) : null}
      {typeof detail === "string" ? null : (
        <Ready language={language} detail={detail} model={model} />
      )}
    </Stack>
  );
}
