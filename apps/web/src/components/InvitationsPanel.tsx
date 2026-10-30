"use client";
import type { InvitationCampaigns } from "@questify/shared";
import { InvitationCard } from "#src/components/InvitationCard.tsx";
import { InvitationForm } from "#src/components/InvitationForm.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { useInvitationCatalogs } from "#src/lib/use-invitation-catalogs.ts";
import {
  useInvitations,
  type InvitationsModel,
  type InvitationsProps,
} from "#src/lib/use-invitations.ts";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";

type Props = InvitationsProps & Readonly<{ myRole: "owner" | "editor" }>;
type Catalogs = ReturnType<typeof useInvitationCatalogs>;

const OPEN_STATES = ["requested", "approved", "sending"];

/** What the owner can do now: the form, or why not (switch off, a request already open); an editor only reads. */
function OwnerActions({
  props,
  model,
  catalogs,
  list,
}: Readonly<{
  props: Props;
  model: InvitationsModel;
  catalogs: Catalogs;
  list: InvitationCampaigns;
}>) {
  const t = translatorFor(props.language);
  const hasOpen = list.campaigns.some((one) => OPEN_STATES.includes(one.state));
  if (props.myRole !== "owner") {
    return <Muted>{t("invCampaign.ownerOnly")}</Muted>;
  }
  if (!list.enabled) {
    return null;
  }
  return hasOpen ? (
    <Muted>{t("invCampaign.openExists")}</Muted>
  ) : (
    <InvitationForm
      language={props.language}
      catalogs={catalogs}
      catalogsFailed={catalogs.failed}
      busy={model.busy}
      submit={model.submit}
      edited={model.dismiss}
    />
  );
}

function Requests({
  props,
  model,
  catalogs,
  list,
}: Readonly<{
  props: Props;
  model: InvitationsModel;
  catalogs: Catalogs;
  list: InvitationCampaigns;
}>) {
  const t = translatorFor(props.language);
  return (
    <>
      {list.enabled ? null : <Notice tone="warning">{t("invCampaign.off")}</Notice>}
      <OwnerActions props={props} model={model} catalogs={catalogs} list={list} />
      {list.campaigns.length === 0 ? <EmptyState>{t("invCampaign.empty")}</EmptyState> : null}
      {list.campaigns.map((campaign) => (
        <InvitationCard
          key={campaign.id}
          campaign={campaign}
          language={props.language}
          catalogs={catalogs}
          canWithdraw={props.myRole === "owner"}
          busy={model.busy}
          withdraw={() => {
            if (window.confirm(t("invCampaign.withdrawConfirm"))) {
              void model.withdraw(campaign.id);
            }
          }}
        />
      ))}
    </>
  );
}

/**
 * An event's Questify invitations (T-409b, FR-738, FR-739): the owner asks Questify to invite chosen players, Questify
 * agrees the price outside the platform and approves in the console; the page shows each request's state and the
 * rounded daily counts, never exact numbers or players. Editors read; the owner requests and withdraws.
 */
export function InvitationsPanel(props: Props) {
  const t = translatorFor(props.language);
  const model = useInvitations(props);
  const catalogs = useInvitationCatalogs();
  return (
    <Stack as="section" aria-labelledby="invitations-title">
      <PageHeader
        titleId="invitations-title"
        title={t("invCampaign.title")}
        info={<InfoTip label={t("common.info")}>{t("invCampaign.intro")}</InfoTip>}
      />
      <Notice tone="info">{t("invCampaign.noCharge")}</Notice>
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
      {model.list === null ? (
        model.problem === null && <Muted role="status">{t("common.loading")}</Muted>
      ) : (
        <Requests props={props} model={model} catalogs={catalogs} list={model.list} />
      )}
    </Stack>
  );
}
