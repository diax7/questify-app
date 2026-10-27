"use client";
import { formatNumber, type AdminInvitationDetail, type Language } from "@questify/shared";
import { Criteria, Decision } from "#src/components/InvitationCard.tsx";
import { nameIn } from "#src/lib/console.ts";
import { NAME_REASON_KEYS, NOT_ELIGIBLE_KEYS, riyadhTime } from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useInvitationCatalogs } from "#src/lib/use-invitation-catalogs.ts";
import styles from "#src/components/layout.module.css";

type PartProps = Readonly<{ language: Language; detail: AdminInvitationDetail }>;

/** Who asked, for which event, what they asked for and what was decided. */
export function Facts({ language, detail }: PartProps) {
  const t = translatorFor(language);
  const catalogs = useInvitationCatalogs();
  const { campaign } = detail;
  return (
    <div className={styles.formCard}>
      <p className={styles.row}>
        <span className={styles.badge} data-testid="detail-state">
          {t(`invCampaign.state.${campaign.state}`)}
        </span>
        <span className={styles.muted}>
          {t("invCampaign.card.requestedAt", { time: riyadhTime(campaign.requestedAt, language) })}
        </span>
      </p>
      <p dir="auto">
        <bdi>{campaign.organizer.name}</bdi> · <bdi>{nameIn(campaign.event.name, language)}</bdi> ·{" "}
        <bdi dir="ltr">{campaign.event.joinCode}</bdi>
      </p>
      <Criteria campaign={campaign} language={language} catalogs={catalogs} />
      <Decision campaign={campaign} language={language} noteKey="console.invCampaign.noteLine" />
      {detail.estimate === null ? null : (
        <p data-testid="estimate">
          {t("console.invCampaign.estimate", { count: detail.estimate })}
        </p>
      )}
    </div>
  );
}

/** What blocks or warns: the paused SMS channel, an event that no longer qualifies, a name the SMS cannot carry. */
export function Warnings({ language, detail }: PartProps) {
  const t = translatorFor(language);
  return (
    <>
      {detail.hold === null ? null : (
        <p role="alert" className={styles.warning} data-testid="hold">
          {t("console.invCampaign.hold", {
            time: riyadhTime(detail.hold.holdUntil, language),
            code: detail.hold.code,
          })}
        </p>
      )}
      {detail.eventIssue === null ? null : (
        <p role="alert" className={styles.warning}>
          {t(NOT_ELIGIBLE_KEYS[detail.eventIssue])}
        </p>
      )}
      {(["ar", "en"] as const).map((one) => {
        const { issue } = detail.names[one];
        return issue === null || detail.campaign.state !== "requested" ? null : (
          <p key={one} role="alert" className={styles.warning}>
            {t(`invCampaign.nameProblem.${one}`, { reason: t(NAME_REASON_KEYS[issue]) })}
          </p>
        );
      })}
    </>
  );
}

/** The event's names as they are now, each with the name rule's verdict. */
export function Names({ language, detail }: PartProps) {
  const t = translatorFor(language);
  const approved = detail.campaign.approvedNames;
  return (
    <div className={styles.formCard}>
      <h2 className={styles.subtitle}>{t("console.invCampaign.names")}</h2>
      {(["ar", "en"] as const).map((one) => {
        const { name, issue } = detail.names[one];
        return (
          <p key={one} data-testid={`name-${one}`}>
            {t(`invCampaign.language.${one}`)}:{" "}
            {name === null || name.trim() === "" ? (
              <span className={styles.muted}>{t("console.invCampaign.nameNone")}</span>
            ) : (
              <bdi dir="auto">{name}</bdi>
            )}
            {name === null || issue !== null || detail.campaign.state !== "requested" ? null : (
              <span className={styles.muted}> · {t("console.invCampaign.nameOk")}</span>
            )}
          </p>
        );
      })}
      {approved.ar === null && approved.en === null ? null : (
        <p className={styles.muted} data-testid="approved-names">
          {t("console.invCampaign.namesApproved")} <bdi dir="auto">{approved.ar ?? "-"}</bdi> ·{" "}
          <bdi dir="auto">{approved.en ?? "-"}</bdi>
        </p>
      )}
    </div>
  );
}

/** The exact text each language's players get, with the number of SMS parts. */
export function Messages({ language, detail }: PartProps) {
  const t = translatorFor(language);
  const frozen = detail.campaign.state !== "requested";
  const shown = (["ar", "en"] as const).filter((one) => detail.messages[one] !== null);
  if (shown.length === 0) {
    return null;
  }
  return (
    <div className={styles.formCard}>
      <h2 className={styles.subtitle}>
        {t(
          frozen
            ? "console.invCampaign.messages.approved"
            : "console.invCampaign.messages.toApprove",
        )}
      </h2>
      <p className={styles.muted}>
        {t(
          frozen
            ? "console.invCampaign.messages.hintFrozen"
            : "console.invCampaign.messages.hintOpen",
        )}
      </p>
      {shown.map((one) => (
        <div key={one} data-testid={`message-${one}`}>
          <p className={styles.muted}>
            {t("console.invCampaign.messages.label", {
              language: t(`invCampaign.language.${one}`),
              parts: detail.messages[one]?.parts ?? 0,
            })}
          </p>
          <p className={styles.prose} dir="auto" data-testid={`message-text-${one}`}>
            {detail.messages[one]?.text}
          </p>
        </div>
      ))}
    </div>
  );
}

/** The exact counters, which only the console sees. */
export function Counters({ language, detail }: PartProps) {
  const t = translatorFor(language);
  const { counts } = detail.campaign;
  const rows = [
    ["planned", counts.planned],
    ["sent", counts.sent],
    ["unknown", counts.unknown],
    ["failed", counts.failed],
    ["skipped", counts.skipped],
    ["cancelled", counts.cancelled],
    ["opened", counts.opened],
    ["joined", counts.joined],
  ] as const;
  return (
    <div className={styles.formCard} data-testid="counters">
      <h2 className={styles.subtitle}>{t("console.invCampaign.counters")}</h2>
      <ul className={styles.list}>
        {rows.map(([name, value]) => (
          <li key={name}>
            {t(`console.invCampaign.counter.${name}`)}:{" "}
            <strong data-testid={`counter-${name}`}>{formatNumber(value, language)}</strong>
          </li>
        ))}
        <li>
          {t("console.invCampaign.counter.queued")}:{" "}
          <strong data-testid="counter-queued">{formatNumber(detail.queued, language)}</strong>
        </li>
      </ul>
    </div>
  );
}
