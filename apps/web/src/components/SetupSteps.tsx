"use client";

import type { Language, SetupStep } from "@questify/shared";
import type { ReactNode } from "react";
import { ActivationCard } from "#src/components/ActivationCard.tsx";
import { EventBranding } from "#src/components/EventBranding.tsx";
import { EventFeatureSwitch } from "#src/components/EventFeatureSwitch.tsx";
import { FEATURE_SWITCHES, EventForm } from "#src/components/EventForm.tsx";
import { JoinSetupPanel } from "#src/components/JoinSetupPanel.tsx";
import { PushDefaultsPanel } from "#src/components/PushDefaultsPanel.tsx";
import { RankingSwitch } from "#src/components/RankingSwitch.tsx";
import { RehearsalCard } from "#src/components/RehearsalCard.tsx";
import { ADDONS, AddonCard, DoorRow } from "#src/components/SetupParts.tsx";
import { StepList } from "#src/components/SetupStepList.tsx";
import type { EventView } from "#src/lib/events.ts";
import type { Translate } from "#src/lib/language.ts";
import type { StepFlow } from "#src/components/SetupStepList.tsx";
import type { ReportUnsaved } from "#src/lib/use-unsaved.ts";
import { Row, Rows, Section, SubHeading } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type SwitchName = (typeof FEATURE_SWITCHES)[number][0];

/** What every step needs: who is asking, the event as read, the unlocked add-ons and the wizard's words. */
export type StepProps = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
  event: EventView;
  addons: readonly string[];
  t: Translate;
}>;

/** The address of the event's pages, without a trailing slash. */
const eventPages = (props: StepProps): string =>
  `/${props.language}/organizers/${props.organizerId}/events/${props.eventId}`;

/** The address of one of the event's pages. */
const pageOf = (props: StepProps, slug: string): string => `${eventPages(props)}/${slug}`;

/** Each switch the event page has, saved by the same operation, with the same words and confirmations. */
function Switches({ names, ...props }: StepProps & Readonly<{ names: readonly SwitchName[] }>) {
  return names.map((name) => (
    <EventFeatureSwitch
      key={name}
      language={props.language}
      feature={name}
      organizerId={props.organizerId}
      eventId={props.eventId}
      initial={FEATURE_SWITCHES.find(([feature]) => feature === name)?.[1](props.event) ?? true}
      myRole={props.myRole}
      live={props.event.statusNow === "live"}
    />
  ));
}

function QuestsStep(props: StepProps) {
  const { t } = props;
  return (
    <Section title={t("events.section.features")}>
      <Rows as="div">
        <Switches
          {...props}
          names={[
            "shareQuests",
            "meetSomeone",
            "miniGames",
            "polls",
            "flashQuests",
            "boosts",
            "community",
            "questRatings",
          ]}
        />
        <Row
          as="div"
          main={
            <SubHeading>
              {t("wizard.quests.nfc")}
              {infoTip(t, "wizard.quests.nfcHint")}
            </SubHeading>
          }
        />
        <DoorRow t={t} title={t("quests.title")} href={pageOf(props, "quests")} />
      </Rows>
    </Section>
  );
}

function RewardsStep(props: StepProps) {
  const { t } = props;
  return (
    <Section title={t("events.section.features")}>
      <Rows as="div">
        <Switches {...props} names={["shop"]} />
        <DoorRow t={t} title={t("rewards.title")} href={pageOf(props, "rewards")} />
        <DoorRow t={t} title={t("prizes.link")} href={pageOf(props, "prizes")} />
      </Rows>
    </Section>
  );
}

function ScreensStep(props: StepProps) {
  const { t } = props;
  return (
    <Section title={t("events.section.features")}>
      <Rows as="div">
        <AddonCard
          t={t}
          language={props.language}
          feature="bigScreen"
          unlocked={props.addons.includes("bigScreen")}
          eventPages={eventPages(props)}
        />
        <Switches {...props} names={["helpDesk"]} />
        <DoorRow t={t} title={t("operators.link")} href={pageOf(props, "operators")} />
      </Rows>
    </Section>
  );
}

function LookStep(props: StepProps) {
  const { t, event } = props;
  return (
    <>
      <EventBranding
        language={props.language}
        organizerId={props.organizerId}
        eventId={props.eventId}
        initial={event.branding?.accent ?? null}
      />
      <Section title={t("events.section.features")}>
        <Rows as="div">
          <RankingSwitch
            language={props.language}
            organizerId={props.organizerId}
            eventId={props.eventId}
            initial={{ ranking: event.ranking, rankingToday: event.rankingToday }}
            myRole={props.myRole}
          />
          <Switches {...props} names={["agenda", "maps"]} />
          <DoorRow t={t} title={t("layout.title")} href={pageOf(props, "layout")} />
          <DoorRow t={t} title={t("preview.title")} href={pageOf(props, "preview")} />
        </Rows>
      </Section>
    </>
  );
}

function AddonsStep(props: StepProps) {
  const { t } = props;
  return (
    <>
      <ActivationCard
        language={props.language}
        organizerId={props.organizerId}
        eventId={props.eventId}
        myRole={props.myRole}
      />
      <Section title={t("wizard.addons.list")}>
        <Rows as="div">
          {ADDONS.map((feature) => (
            <AddonCard
              key={feature}
              t={t}
              language={props.language}
              feature={feature}
              unlocked={props.addons.includes(feature)}
              eventPages={eventPages(props)}
            />
          ))}
        </Rows>
      </Section>
    </>
  );
}

type BodyProps = StepProps & Readonly<{ flow: StepFlow; onUnsaved: ReportUnsaved }>;

const idsOf = (props: StepProps) => ({
  language: props.language,
  organizerId: props.organizerId,
  eventId: props.eventId,
});

function SponsorsStep(props: StepProps) {
  const { t } = props;
  return (
    <Section title={t("sponsors.page.title")}>
      <Rows as="div">
        <DoorRow t={t} title={t("sponsors.page.add")} href={pageOf(props, "sponsors")} />
      </Rows>
    </Section>
  );
}

function MessagesStep(props: StepProps) {
  const { t } = props;
  return (
    <>
      <PushDefaultsPanel
        language={props.language}
        path={`/v1/organizers/${props.organizerId}/events/${props.eventId}/push-defaults`}
      />
      <Section title={t("announcements.page.title")}>
        <Rows as="div">
          <DoorRow
            t={t}
            title={t("announcements.page.title")}
            href={pageOf(props, "announcements")}
          />
        </Rows>
      </Section>
    </>
  );
}

function ReviewStep(props: BodyProps) {
  return (
    <>
      <Section title={props.t("setup.stepsList")}>
        <StepList t={props.t} flow={props.flow} lastStep={9} />
      </Section>
      <RehearsalCard {...idsOf(props)} />
    </>
  );
}

const BODIES: Readonly<Record<SetupStep, (props: BodyProps) => ReactNode>> = {
  basics: (props) => (
    <EventForm {...idsOf(props)} myRole={props.myRole} bare onUnsaved={props.onUnsaved} />
  ),
  join: (props) => <JoinSetupPanel {...idsOf(props)} bare onUnsaved={props.onUnsaved} />,
  quests: QuestsStep,
  rewards: RewardsStep,
  sponsors: SponsorsStep,
  screens: ScreensStep,
  look: LookStep,
  messages: MessagesStep,
  addons: AddonsStep,
  review: ReviewStep,
};

/** The body of the step being shown: the same panels, switches and doors the event's own pages have. */
export function StepBody({ step, ...props }: BodyProps & Readonly<{ step: SetupStep }>) {
  return BODIES[step](props);
}
