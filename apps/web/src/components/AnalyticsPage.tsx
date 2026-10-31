"use client";

import {
  economySchema,
  formatNumber,
  participationSchema,
  questsAnalyticsSchema,
  type Economy,
  type Language,
  type Participation,
  type QuestsAnalytics,
} from "@questify/shared";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  AllFunnels,
  CategoryFunnel,
  JoinedBySource,
  JoinedOverTime,
  JoinedOverTimeList,
  QuestList,
  RewardRedemptions,
  WherePlayersStop,
  funnelChoices,
  useCurrencyWord,
} from "#src/components/AnalyticsParts.tsx";
import { QuestScoresScope } from "#src/components/QuestScoreBadge.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { PANEL_ROWS, popularity, stopsOf } from "#src/lib/analytics.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Figure, PanelGrid, Tile, WideCard } from "#src/ui/Charts.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { infoTip } from "#src/ui/info.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Section, Stack, SubHeading } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Schema<T> = Readonly<{
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}>;
type PanelState<T> =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "ready"; data: T }>;
type Panel<T> = Readonly<{ state: PanelState<T>; retry: () => void }>;

/**
 * One panel's figures, read once when the page opens and again on Try again. The three panels load on their own, so
 * a slow one never holds the others; a failed one says so and keeps its frame.
 */
function useAnalyticsPanel<T>(
  language: Language,
  eventApi: string,
  name: "participation" | "quests" | "economy",
  schema: Schema<T>,
): Panel<T> {
  const [state, setState] = useState<PanelState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void requestJson("GET", `${eventApi}/analytics/${name}`).then((result) => {
      if (!current) {
        return;
      }
      const code = errorCodeOf(result.body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      const parsed = result.ok ? schema.safeParse(result.body) : undefined;
      setState(
        parsed?.success === true ? { status: "ready", data: parsed.data } : { status: "failed" },
      );
    });
    return () => {
      current = false;
    };
  }, [language, eventApi, name, schema, attempt]);
  return {
    state,
    retry: () => {
      setState({ status: "loading" });
      setAttempt((count) => count + 1);
    },
  };
}

/** What a card or tile holds while its figures are not there: the loading words, or a dash after a failure. */
function Pending({ language, failed }: Readonly<{ language: Language; failed: boolean }>) {
  const t = useTranslator(language);
  return <Muted>{failed ? "—" : t("common.loading")}</Muted>;
}

/** A card of a panel grid: a titled box, with "View more" when a list has more than the card shows. */
function Card<T>({
  language,
  title,
  info,
  panel,
  more,
  children,
}: Readonly<{
  language: Language;
  title: string;
  info?: ReactNode;
  panel: Panel<T>;
  /** The rest of the list, or null while the card shows all of it. */
  more?: (data: T) => ReactNode;
  children: (data: T) => ReactNode;
}>) {
  const t = useTranslator(language);
  const [open, setOpen] = useState(false);
  const ready = panel.state.status === "ready" ? panel.state.data : undefined;
  const rest = ready === undefined || more === undefined ? null : more(ready);
  return (
    <>
      <Section
        level={3}
        title={title}
        info={info}
        actions={
          rest === null ? undefined : (
            <Button
              variant="quiet"
              size="sm"
              aria-label={t("analytics.viewMoreOf", { title })}
              onClick={() => setOpen(true)}
            >
              {t("analytics.viewMore")}
            </Button>
          )
        }
      >
        {ready === undefined ? (
          <Pending language={language} failed={panel.state.status === "failed"} />
        ) : (
          children(ready)
        )}
      </Section>
      {open && rest !== null ? (
        <Dialog
          title={title}
          role="dialog"
          cancel={() => setOpen(false)}
          actions={<Button onClick={() => setOpen(false)}>{t("common.close")}</Button>}
        >
          {rest}
        </Dialog>
      ) : null}
    </>
  );
}

/** A figure tile: the number once it is read, the loading words before, a dash after a failure. */
function FigureTile<T>({
  language,
  title,
  info,
  panel,
  pick,
}: Readonly<{
  language: Language;
  title: string;
  info?: ReactNode;
  panel: Panel<T>;
  pick: (data: T) => string;
}>) {
  return (
    <Tile title={title} info={info}>
      {panel.state.status === "ready" ? (
        <Figure>{pick(panel.state.data)}</Figure>
      ) : (
        <Pending language={language} failed={panel.state.status === "failed"} />
      )}
    </Tile>
  );
}

/** One titled group of the page, with a message and Try again when its figures did not load. */
function Group({
  language,
  title,
  failed,
  retry,
  children,
}: Readonly<{
  language: Language;
  title: string;
  failed: boolean;
  retry: () => void;
  children: ReactNode;
}>) {
  const t = useTranslator(language);
  const id = useId();
  return (
    <Stack as="section" aria-labelledby={id}>
      <SubHeading as="h2" id={id}>
        {title}
      </SubHeading>
      {failed ? (
        <Notice tone="danger" role="alert">
          {t("analytics.loadFailed")}{" "}
          <Button size="sm" onClick={retry}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {children}
    </Stack>
  );
}

type Props = Readonly<{ language: Language }>;

/** Participation (FR-1201, FR-1202, FR-1625): four figures, players over time and the join sources. */
function ParticipationGroup({
  language,
  panel,
}: Props & Readonly<{ panel: Panel<Participation> }>) {
  const t = useTranslator(language);
  const number = (pick: (data: Participation) => number) => (data: Participation) =>
    formatNumber(pick(data), language);
  return (
    <Group
      language={language}
      title={t("analytics.group.participation")}
      failed={panel.state.status === "failed"}
      retry={panel.retry}
    >
      <PanelGrid kind="tiles">
        <FigureTile
          language={language}
          title={t("analytics.joined")}
          panel={panel}
          pick={number((d) => d.joined)}
        />
        <FigureTile
          language={language}
          title={t("analytics.active")}
          info={infoTip(t, "analytics.activeInfo")}
          panel={panel}
          pick={number((d) => d.active)}
        />
        <FigureTile
          language={language}
          title={t("analytics.activation")}
          info={infoTip(t, "analytics.activationInfo")}
          panel={panel}
          pick={(d) => (d.activation === null ? "—" : `${formatNumber(d.activation, language)}%`)}
        />
        <FigureTile
          language={language}
          title={t("analytics.returning")}
          info={infoTip(t, "analytics.returningInfo")}
          panel={panel}
          pick={number((d) => d.returning)}
        />
      </PanelGrid>
      <PanelGrid>
        <Card
          language={language}
          title={t("analytics.overTime")}
          panel={panel}
          more={(data) =>
            data.series.length > 1 ? <JoinedOverTimeList language={language} data={data} /> : null
          }
        >
          {(data) => <JoinedOverTime language={language} data={data} />}
        </Card>
        <Card language={language} title={t("analytics.sources")} panel={panel}>
          {(data) => <JoinedBySource language={language} data={data} />}
        </Card>
      </PanelGrid>
    </Group>
  );
}

/** Quests and categories (FR-1204): the most and least popular quests, a category's funnel and where players stop. */
function QuestsGroup({ language, panel }: Props & Readonly<{ panel: Panel<QuestsAnalytics> }>) {
  const t = useTranslator(language);
  const allQuests = (data: QuestsAnalytics) => {
    const { all } = popularity(data);
    return all.length > PANEL_ROWS ? <QuestList language={language} rows={all} /> : null;
  };
  const hasLeast = panel.state.status !== "ready" || popularity(panel.state.data).least.length > 0;
  return (
    <Group
      language={language}
      title={t("analytics.group.quests")}
      failed={panel.state.status === "failed"}
      retry={panel.retry}
    >
      <PanelGrid>
        <Card language={language} title={t("analytics.mostPopular")} panel={panel} more={allQuests}>
          {(data) => <QuestList language={language} rows={popularity(data).most} />}
        </Card>
        {hasLeast ? (
          <Card
            language={language}
            title={t("analytics.leastPopular")}
            panel={panel}
            more={allQuests}
          >
            {(data) => <QuestList language={language} rows={popularity(data).least} />}
          </Card>
        ) : null}
      </PanelGrid>
      <PanelGrid>
        <Card
          language={language}
          title={t("analytics.funnel")}
          panel={panel}
          more={(data) =>
            funnelChoices(data).choices.some((choice) => choice.steps.length > PANEL_ROWS) ? (
              <AllFunnels language={language} data={data} />
            ) : null
          }
        >
          {(data) => <CategoryFunnel language={language} data={data} />}
        </Card>
        <Card
          language={language}
          title={t("analytics.stops")}
          panel={panel}
          more={(data) =>
            stopsOf(data).length > PANEL_ROWS ? (
              <WherePlayersStop language={language} data={data} all />
            ) : null
          }
        >
          {(data) => <WherePlayersStop language={language} data={data} all={false} />}
        </Card>
      </PanelGrid>
    </Group>
  );
}

/** Rewards and points (FR-1205): points earned and spent, unclaimed reservations and each reward's redemptions. */
function EconomyGroup({ language, panel }: Props & Readonly<{ panel: Panel<Economy> }>) {
  const t = useTranslator(language);
  const currency = useCurrencyWord(language);
  const number = (pick: (data: Economy) => number) => (data: Economy) =>
    formatNumber(pick(data), language);
  return (
    <Group
      language={language}
      title={t("analytics.group.rewards")}
      failed={panel.state.status === "failed"}
      retry={panel.retry}
    >
      <PanelGrid kind="tiles">
        <FigureTile
          language={language}
          title={t("analytics.earned", { currency })}
          panel={panel}
          pick={number((d) => d.earned)}
        />
        <FigureTile
          language={language}
          title={t("analytics.spent", { currency })}
          panel={panel}
          pick={number((d) => d.spent)}
        />
        <FigureTile
          language={language}
          title={t("analytics.unclaimed")}
          panel={panel}
          pick={number((d) => d.unclaimed)}
        />
      </PanelGrid>
      <PanelGrid>
        <WideCard>
          <Card
            language={language}
            title={t("analytics.rewards")}
            panel={panel}
            more={(data) =>
              data.rewards.length > PANEL_ROWS ? (
                <RewardRedemptions language={language} data={data} all />
              ) : null
            }
          >
            {(data) => <RewardRedemptions language={language} data={data} all={false} />}
          </Card>
        </WideCard>
      </PanelGrid>
    </Group>
  );
}

/**
 * The event's analytics (T-607, FR-1201 to FR-1205, FR-1625): participation, quests and categories, and rewards and
 * points, each from its own read, counts only and never a player. An event that still holds rehearsal accounts says
 * its figures include them.
 */
export function AnalyticsPage({
  language,
  organizerId,
  eventId,
}: Readonly<{ language: Language; organizerId: string; eventId: string }>) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const participation = useAnalyticsPanel(language, eventApi, "participation", participationSchema);
  const quests = useAnalyticsPanel(language, eventApi, "quests", questsAnalyticsSchema);
  const economy = useAnalyticsPanel(language, eventApi, "economy", economySchema);
  const rehearsal = participation.state.status === "ready" && participation.state.data.rehearsal;
  return (
    <QuestScoresScope organizerId={organizerId} eventId={eventId}>
      <Stack as="section" aria-labelledby="analytics-title">
        <PageHeader titleId="analytics-title" title={t("analytics.title")} />
        {rehearsal ? (
          <Notice tone="info" role="note">
            {t("analytics.rehearsal")}
          </Notice>
        ) : null}
        <ParticipationGroup language={language} panel={participation} />
        <QuestsGroup language={language} panel={quests} />
        <EconomyGroup language={language} panel={economy} />
      </Stack>
    </QuestScoresScope>
  );
}
