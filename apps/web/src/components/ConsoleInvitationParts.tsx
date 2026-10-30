"use client";
import { formatNumber, type AdminInvitationDetail, type Language } from "@questify/shared";
import { Criteria, Decision } from "#src/components/InvitationCard.tsx";
import { nameIn } from "#src/lib/console.ts";
import { NAME_REASON_KEYS, NOT_ELIGIBLE_KEYS, riyadhTime } from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useInvitationCatalogs } from "#src/lib/use-invitation-catalogs.ts";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Card, CardList, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { Prose } from "#src/ui/Text.tsx";

type PartProps = Readonly<{ language: Language; detail: AdminInvitationDetail }>;

/** Who asked, for which event, what they asked for and what was decided. */
export function Facts({ language, detail }: PartProps) {
  const t = translatorFor(language);
  const catalogs = useInvitationCatalogs();
  const { campaign } = detail;
  return (
    <Card>
      <Toolbar>
        <Badge data-testid="detail-state">{t(`invCampaign.state.${campaign.state}`)}</Badge>
        <Muted as="span">
          {t("invCampaign.card.requestedAt", { time: riyadhTime(campaign.requestedAt, language) })}
        </Muted>
      </Toolbar>
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
    </Card>
  );
}

/** What blocks or warns: the paused SMS channel, an event that no longer qualifies, a name the SMS cannot carry. */
export function Warnings({ language, detail }: PartProps) {
  const t = translatorFor(language);
  return (
    <>
      {detail.hold === null ? null : (
        <Notice tone="warning" role="alert" data-testid="hold">
          {t("console.invCampaign.hold", {
            time: riyadhTime(detail.hold.holdUntil, language),
            code: detail.hold.code,
          })}
        </Notice>
      )}
      {detail.eventIssue === null ? null : (
        <Notice tone="warning" role="alert">
          {t(NOT_ELIGIBLE_KEYS[detail.eventIssue])}
        </Notice>
      )}
      {(["ar", "en"] as const).map((one) => {
        const { issue } = detail.names[one];
        return issue === null || detail.campaign.state !== "requested" ? null : (
          <Notice tone="warning" key={one} role="alert">
            {t(`invCampaign.nameProblem.${one}`, { reason: t(NAME_REASON_KEYS[issue]) })}
          </Notice>
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
    <Card>
      <SubHeading as="h2">{t("console.invCampaign.names")}</SubHeading>
      {(["ar", "en"] as const).map((one) => {
        const { name, issue } = detail.names[one];
        return (
          <p key={one} data-testid={`name-${one}`}>
            {t(`invCampaign.language.${one}`)}:{" "}
            {name === null || name.trim() === "" ? (
              <Muted as="span">{t("console.invCampaign.nameNone")}</Muted>
            ) : (
              <bdi dir="auto">{name}</bdi>
            )}
            {name === null || issue !== null || detail.campaign.state !== "requested" ? null : (
              <Muted as="span"> · {t("console.invCampaign.nameOk")}</Muted>
            )}
          </p>
        );
      })}
      {approved.ar === null && approved.en === null ? null : (
        <Muted data-testid="approved-names">
          {t("console.invCampaign.namesApproved")} <bdi dir="auto">{approved.ar ?? "-"}</bdi> ·{" "}
          <bdi dir="auto">{approved.en ?? "-"}</bdi>
        </Muted>
      )}
    </Card>
  );
}

/** The exact text each language's players get, with the number of SMS parts, and the push beside it. */
export function Messages({ language, detail }: PartProps) {
  const t = translatorFor(language);
  const frozen = detail.campaign.state !== "requested";
  const shown = (["ar", "en"] as const).filter((one) => detail.messages[one] !== null);
  if (shown.length === 0) {
    return null;
  }
  return (
    <Card>
      <SubHeading as="h2">
        {t(
          frozen
            ? "console.invCampaign.messages.approved"
            : "console.invCampaign.messages.toApprove",
        )}
      </SubHeading>
      <Muted>
        {t(
          frozen
            ? "console.invCampaign.messages.hintFrozen"
            : "console.invCampaign.messages.hintOpen",
        )}
      </Muted>
      {shown.map((one) => (
        <div key={one} data-testid={`message-${one}`}>
          <Muted>
            {t("console.invCampaign.messages.label", {
              language: t(`invCampaign.language.${one}`),
              parts: detail.messages[one]?.parts ?? 0,
            })}
          </Muted>
          <Prose dir="auto" data-testid={`message-text-${one}`}>
            {detail.messages[one]?.text}
          </Prose>
          {detail.pushMessages[one] === null ? null : (
            <>
              <Muted>
                {t("console.invCampaign.messages.pushLabel", {
                  language: t(`invCampaign.language.${one}`),
                })}
              </Muted>
              <Prose dir="auto" data-testid={`push-text-${one}`}>
                <strong>{detail.pushMessages[one]?.title}</strong> {detail.pushMessages[one]?.body}
              </Prose>
            </>
          )}
        </div>
      ))}
    </Card>
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
    <Card data-testid="counters">
      <SubHeading as="h2">{t("console.invCampaign.counters")}</SubHeading>
      <CardList>
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
      </CardList>
    </Card>
  );
}
