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
import styles from "#src/components/layout.module.css";

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
    return <p className={styles.muted}>{t("invCampaign.ownerOnly")}</p>;
  }
  if (!list.enabled) {
    return null;
  }
  return hasOpen ? (
    <p className={styles.muted}>{t("invCampaign.openExists")}</p>
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
      {list.enabled ? null : <p className={styles.warning}>{t("invCampaign.off")}</p>}
      <OwnerActions props={props} model={model} catalogs={catalogs} list={list} />
      {list.campaigns.length === 0 ? (
        <p className={styles.muted}>{t("invCampaign.empty")}</p>
      ) : null}
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
    <section className={styles.stack} aria-labelledby="invitations-title">
      <h1 id="invitations-title" className={styles.title}>
        {t("invCampaign.title")}
      </h1>
      <p>{t("invCampaign.intro")}</p>
      <p className={styles.notice}>{t("invCampaign.noCharge")}</p>
      <p className={styles.muted}>{t("invCampaign.privacy")}</p>
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
      {model.list === null ? (
        model.problem === null && (
          <p role="status" className={styles.muted}>
            {t("common.loading")}
          </p>
        )
      ) : (
        <Requests props={props} model={model} catalogs={catalogs} list={model.list} />
      )}
    </section>
  );
}
