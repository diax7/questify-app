"use client";

import {
  MIN_GROUP_SIZE,
  formatNumber,
  sponsorTotalsSchema,
  teamSponsorListSchema,
  type Language,
  type SponsorTotals,
  type TeamSponsor,
} from "@questify/shared";
import { useEffect, useId, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { sponsorName } from "#src/lib/sponsors.ts";
import { textFor } from "#src/lib/quests.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { BarRows, Figure, PanelGrid, Tile, WideCard, type BarRow } from "#src/ui/Charts.tsx";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Select } from "#src/ui/Field.tsx";
import { infoTip } from "#src/ui/info.tsx";
import { Section, Stack, SubHeading } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The event's sponsors, read once; null while they load or when they could not be read. */
export function useSponsors(eventApi: string): readonly TeamSponsor[] | null {
  const [sponsors, setSponsors] = useState<readonly TeamSponsor[] | null>(null);
  useEffect(() => {
    let current = true;
    void requestJson("GET", `${eventApi}/sponsors`).then((result) => {
      const parsed = result.ok ? teamSponsorListSchema.safeParse(result.body) : undefined;
      if (current && parsed?.success === true) {
        setSponsors(parsed.data.sponsors);
      }
    });
    return () => {
      current = false;
    };
  }, [eventApi]);
  return sponsors;
}

/** The sponsor filter (FR-1306): all sponsors, or one, whose totals replace the event's figures; nothing for an event without sponsors. */
export function SponsorFilter({
  language,
  sponsors,
  value,
  onChange,
}: Readonly<{
  language: Language;
  sponsors: readonly TeamSponsor[];
  value: string;
  onChange: (sponsorId: string) => void;
}>) {
  const t = useTranslator(language);
  if (sponsors.length === 0) {
    return null;
  }
  return (
    <Field label={t("analytics.sponsor.label")}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t("analytics.sponsor.all")}</option>
        {sponsors.map((sponsor) => (
          <option key={sponsor.id} value={sponsor.id}>
            {sponsorName(sponsor, language)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

type State =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "ready"; totals: SponsorTotals }>;

function useSponsorTotals(language: Language, eventApi: string, sponsorId: string) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void requestJson("GET", `${eventApi}/analytics/sponsors/${sponsorId}`).then((result) => {
      if (!current) {
        return;
      }
      const code = errorCodeOf(result.body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      const parsed = result.ok ? sponsorTotalsSchema.safeParse(result.body) : undefined;
      setState(
        parsed?.success === true ? { status: "ready", totals: parsed.data } : { status: "failed" },
      );
    });
    return () => {
      current = false;
    };
  }, [language, eventApi, sponsorId, attempt]);
  return { state, retry: () => setAttempt((count) => count + 1) };
}

/** A count as the sponsor may see it: the number, or "Fewer than 5". */
export function useCountText(language: Language) {
  const t = useTranslator(language);
  return (count: number | null): string =>
    count === null
      ? t("analytics.sponsor.fewer", { count: formatNumber(MIN_GROUP_SIZE, language) })
      : formatNumber(count, language);
}

function itemRows(
  items: readonly Readonly<{ id: string; label: string; count: number | null }>[],
  text: (count: number | null) => string,
): BarRow[] {
  const most = Math.max(1, ...items.map((item) => item.count ?? 0));
  return items.map((item) => ({
    key: item.id,
    label: <span dir="auto">{item.label}</span>,
    value: text(item.count),
    share: (item.count ?? 0) / most,
  }));
}

function Totals({ language, totals }: Readonly<{ language: Language; totals: SponsorTotals }>) {
  const t = useTranslator(language);
  const text = useCountText(language);
  const playersText = (count: number | null) =>
    count === null
      ? text(null)
      : t("analytics.sponsor.players", { count: formatNumber(count, language) });
  const quests = totals.quests.map((quest) => ({
    id: quest.id,
    label: textFor(quest.title, language),
    count: quest.players,
  }));
  const categories = totals.categories.map((category) => ({
    id: category.id,
    label: textFor(category.name, language),
    count: category.players,
  }));
  const rewards = totals.rewards.map((reward) => ({
    id: reward.id,
    label: textFor(reward.name, language),
    count: reward.redeemed,
  }));
  const empty = quests.length + categories.length + rewards.length === 0;
  return (
    <>
      <PanelGrid kind="tiles">
        <Tile
          title={t("analytics.sponsor.visits")}
          info={infoTip(t, "analytics.sponsor.visitsHint")}
        >
          <Figure>{text(totals.visits)}</Figure>
        </Tile>
        <Tile title={t("analytics.sponsor.completions")}>
          <Figure>{text(totals.completions)}</Figure>
        </Tile>
        <Tile title={t("analytics.sponsor.redemptions")}>
          <Figure>{text(totals.redemptions)}</Figure>
        </Tile>
      </PanelGrid>
      {empty ? (
        <EmptyState>{t("analytics.sponsor.empty")}</EmptyState>
      ) : (
        <PanelGrid>
          <WideCard>
            <Section
              level={3}
              title={t("analytics.group.quests")}
              info={infoTip(t, "analytics.sponsor.fewerHint")}
            >
              <BarRows rows={itemRows([...quests, ...categories], playersText)} />
            </Section>
            {rewards.length === 0 ? null : (
              <Section level={3} title={t("analytics.group.rewards")}>
                <BarRows
                  rows={itemRows(rewards, (count) =>
                    count === null
                      ? text(null)
                      : t("analytics.rewards.redeemed", { count: formatNumber(count, language) }),
                  )}
                />
              </Section>
            )}
          </WideCard>
        </PanelGrid>
      )}
    </>
  );
}

/** One sponsor's totals (FR-1306, FR-1626): visits, completions and redemptions as totals, never a player. */
export function SponsorTotalsView({
  language,
  eventApi,
  sponsor,
}: Readonly<{ language: Language; eventApi: string; sponsor: TeamSponsor }>) {
  const t = useTranslator(language);
  const { state, retry } = useSponsorTotals(language, eventApi, sponsor.id);
  const id = useId();
  return (
    <Stack as="section" aria-labelledby={id}>
      <SubHeading as="h2" id={id}>
        {t("analytics.sponsor.title", { name: sponsorName(sponsor, language) })}
      </SubHeading>
      {state.status === "loading" ? <Muted>{t("common.loading")}</Muted> : null}
      {state.status === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("analytics.loadFailed")}{" "}
          <Button size="sm" onClick={retry}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {state.status === "ready" ? <Totals language={language} totals={state.totals} /> : null}
    </Stack>
  );
}
