"use client";
import { type City, type Interest, type InvitationCampaign, type Language } from "@questify/shared";
import { cityName } from "#src/lib/cities.ts";
import { interestName } from "#src/lib/interests.ts";
import { END_REASON_KEYS, countText, riyadhTime } from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted } from "#src/ui/Feedback.tsx";
import { Card, CardList, Toolbar } from "#src/ui/Section.tsx";

type Catalogs = Readonly<{ cities: readonly City[]; interests: readonly Interest[] }>;
/** What a request asks for, the same for the owner and for the console. */
type AskedFor = Pick<InvitationCampaign, "cityId" | "interests" | "history" | "size" | "sendAfter">;
type CardProps = Readonly<{
  campaign: InvitationCampaign;
  language: Language;
  catalogs: Catalogs;
  /** The owner may withdraw a request that has not started; an editor only reads. */
  canWithdraw: boolean;
  busy: boolean;
  withdraw: () => void;
}>;

/** Who the request asks for: the city, the interests and the history, then the size and the earliest send. */
export function Criteria({
  campaign,
  language,
  catalogs,
}: Readonly<{ campaign: AskedFor; language: Language; catalogs: Catalogs }>) {
  const t = translatorFor(language);
  const city = catalogs.cities.find((one) => one.id === campaign.cityId);
  const interests = campaign.interests.map((id) => {
    const known = catalogs.interests.find((one) => one.id === id);
    return known === undefined ? id : interestName(known, language);
  });
  return (
    <CardList>
      {campaign.cityId === null ? null : (
        <li>
          {t("invCampaign.card.city", {
            city: city === undefined ? campaign.cityId : cityName(city, language),
          })}
        </li>
      )}
      {interests.length === 0 ? null : (
        <li>
          {t("invCampaign.card.interests", {
            interests: interests.join(language === "ar" ? "، " : ", "),
          })}
        </li>
      )}
      <li>{t(`invCampaign.history.${campaign.history}`)}</li>
      <li>{t("invCampaign.card.size", { count: campaign.size })}</li>
      {campaign.sendAfter === null ? null : (
        <li>
          {t("invCampaign.card.sendAfter", { time: riyadhTime(campaign.sendAfter, language) })}
        </li>
      )}
    </CardList>
  );
}

/** The rounded counts (never exact, never who) and when they were last published. */
function Counts({
  campaign,
  language,
}: Readonly<{ campaign: InvitationCampaign; language: Language }>) {
  const t = translatorFor(language);
  const rows = [
    ["sent", "invCampaign.count.sent"],
    ["opened", "invCampaign.count.opened"],
    ["joined", "invCampaign.count.joined"],
  ] as const;
  return (
    <div data-testid="invitation-counts">
      <CardList>
        {rows.map(([name, label]) => (
          <li key={name}>
            {t(label)}:{" "}
            <strong data-testid={`count-${name}`}>
              {countText(campaign.counts[name], language, t)}
            </strong>
          </li>
        ))}
      </CardList>
      <Muted>
        {campaign.publishedAt === null
          ? t("invCampaign.card.daily")
          : t("invCampaign.card.published", { time: riyadhTime(campaign.publishedAt, language) })}
      </Muted>
    </div>
  );
}

type Decided = Pick<InvitationCampaign, "cap" | "sendAt" | "endReason" | "note">;

/** What was decided: the approved size and send time, why it ended, and the note Questify left for the owner. */
export function Decision({
  campaign,
  language,
  noteKey,
}: Readonly<{
  campaign: Decided;
  language: Language;
  noteKey: "invCampaign.card.note" | "console.invCampaign.noteLine";
}>) {
  const t = translatorFor(language);
  return (
    <>
      {campaign.cap === null || campaign.sendAt === null ? null : (
        <p data-testid="approved-line">
          {t("invCampaign.card.approved", {
            count: campaign.cap,
            time: riyadhTime(campaign.sendAt, language),
          })}
        </p>
      )}
      {campaign.endReason === null ? null : <p>{t(END_REASON_KEYS[campaign.endReason])}</p>}
      {campaign.note === null ? null : (
        <p>
          {t(noteKey)} <bdi dir="auto">{campaign.note}</bdi>
        </p>
      )}
    </>
  );
}

/** One request of the event: its state, who it asks for, what Questify approved, and the rounded results. */
export function InvitationCard({
  campaign,
  language,
  catalogs,
  canWithdraw,
  busy,
  withdraw,
}: CardProps) {
  const t = translatorFor(language);
  const open = campaign.state === "requested" || campaign.state === "approved";
  return (
    <Card as="article" data-testid="invitation" data-state={campaign.state}>
      <Toolbar>
        <Badge>{t(`invCampaign.state.${campaign.state}`)}</Badge>
        <Muted as="span">
          {t("invCampaign.card.requestedAt", { time: riyadhTime(campaign.requestedAt, language) })}
        </Muted>
      </Toolbar>
      <Criteria campaign={campaign} language={language} catalogs={catalogs} />
      <Decision campaign={campaign} language={language} noteKey="invCampaign.card.note" />
      {campaign.startedAt === null ? null : <Counts campaign={campaign} language={language} />}
      {open && canWithdraw ? (
        <Toolbar>
          <Button variant="quiet" disabled={busy} onClick={withdraw}>
            {t("invCampaign.withdraw")}
          </Button>
        </Toolbar>
      ) : null}
    </Card>
  );
}
