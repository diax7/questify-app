"use client";

import { formatNumber, isLivePoll, toLocalInput, type Language } from "@questify/shared";
import { FlashControls, type FlashActions } from "#src/components/FlashControls.tsx";
import { PollControls, type PollActions } from "#src/components/PollControls.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { RoomSwitch } from "#src/components/useRoomSwitches.tsx";
import {
  completionRate,
  methodLabelOf,
  type ControlCounts,
  type FeedItem,
} from "#src/lib/control-room.ts";
import { flashStateOf } from "#src/lib/flash.ts";
import { textFor, type CategoryView, type QuestView } from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Meter, Muted } from "#src/ui/Feedback.tsx";
import { Row, Rows } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

type CounterRow = Readonly<{
  key: string;
  label: "control.online" | "control.lowStock" | "control.inbox" | "flags.link";
  count: number;
  /** The page that deals with it, under the event; none for a number with nothing to do. */
  page: string | null;
  /** A number above 0 that asks for the team. */
  needsYou: boolean;
}>;

/** The four live numbers of FR-1028, each a link to the page that deals with it (Active has none). */
export function ControlCounters({
  language,
  counts,
  eventBase,
}: Readonly<{ language: Language; counts: ControlCounts; eventBase: string }>) {
  const t = useTranslator(language);
  const rows: readonly CounterRow[] = [
    { key: "online", label: "control.online", count: counts.online, page: null, needsYou: false },
    {
      key: "low",
      label: "control.lowStock",
      count: counts.lowStock,
      page: "rewards",
      needsYou: counts.lowStock > 0,
    },
    {
      key: "inbox",
      label: "control.inbox",
      count: counts.inbox,
      page: "help",
      needsYou: counts.inbox > 0,
    },
    {
      key: "flags",
      label: "flags.link",
      count: counts.flags,
      page: "flags",
      needsYou: counts.flags > 0,
    },
  ];
  return (
    <Rows>
      {rows.map((row) => (
        <Row
          key={row.key}
          main={
            row.page === null ? (
              t(row.label)
            ) : (
              <TextLink href={`${eventBase}/${row.page}`}>{t(row.label)}</TextLink>
            )
          }
        >
          <Badge tone={row.needsYou ? "warning" : "neutral"}>
            {formatNumber(row.count, language)}
          </Badge>
        </Row>
      ))}
    </Rows>
  );
}

/**
 * The newest completions, newest first (FR-1024): who, which quest, how, and the clock time in the event's zone. A
 * username and avatar are all the team learns of a player here; no contact detail or points.
 */
export function ControlFeed({
  language,
  feed,
  timeZone,
}: Readonly<{ language: Language; feed: readonly FeedItem[]; timeZone: string }>) {
  const t = useTranslator(language);
  if (feed.length === 0) {
    return <EmptyState>{t("control.feed.empty")}</EmptyState>;
  }
  return (
    <Rows>
      {feed.map((item) => (
        <Row
          key={item.id}
          main={
            <>
              <strong dir="auto">{item.username}</strong>{" "}
              <span dir="auto">{textFor(item.title, language)}</span>
            </>
          }
        >
          <Badge>{t(methodLabelOf(item.method))}</Badge>
          <Muted as="span" dir="ltr">
            {toLocalInput(new Date(item.at), timeZone).slice(11)}
          </Muted>
        </Row>
      ))}
    </Rows>
  );
}

type QuestsProps = Readonly<{
  language: Language;
  timeZone: string;
  categories: readonly CategoryView[];
  focusQuestId: string | null;
  done: Readonly<Record<string, number>>;
  players: number;
  busy: boolean;
  /** True once the event has ended: the numbers stay, the buttons go. */
  readOnly: boolean;
  /** False while the event's flash quests switch is off: flash quests then get no Launch or End. */
  flashOn: boolean;
  actions: PollActions & FlashActions;
  pin: (quest: QuestView) => void;
  /** Opens the confirmation of a pause, resume, skip or restore (T-603b). */
  toggle: (kind: RoomSwitch, quest: QuestView) => void;
  /** The in-order categories' ids: only their steps (not flash quests or live polls) can be skipped. */
  inOrder: ReadonlySet<string>;
}>;

/** The pause and skip buttons of one quest (T-603b): Skip step only on a step of an in-order category. */
function SwitchButtons({
  language,
  quest,
  busy,
  skippable,
  toggle,
}: Readonly<{
  language: Language;
  quest: QuestView;
  busy: boolean;
  skippable: boolean;
  toggle: QuestsProps["toggle"];
}>) {
  const t = useTranslator(language);
  const paused = quest.paused === true;
  const skipped = quest.skipped === true;
  return (
    <>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => toggle(paused ? "resume" : "pause", quest)}
      >
        {t(paused ? "control.resume.action" : "control.pause.action")}
      </Button>
      {skippable || skipped ? (
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => toggle(skipped ? "unskip" : "skip", quest)}
        >
          {t(skipped ? "control.unskip.action" : "control.skip.action")}
        </Button>
      ) : null}
    </>
  );
}

function QuestStats({
  language,
  quest,
  done,
  players,
}: Readonly<{
  language: Language;
  quest: QuestView;
  done: number | undefined;
  players: number;
}>) {
  const t = useTranslator(language);
  const rate = completionRate(done, players);
  const count = formatNumber(done ?? 0, language);
  const text = t("control.quests.done", { count, rate: formatNumber(rate, language) });
  return (
    <>
      <Muted as="span">{text}</Muted>
      <Meter
        share={rate / 100}
        reading={{
          label: `${textFor(quest.title, language)}: ${t("control.quests.rate")}`,
          now: rate,
          max: 100,
          text,
        }}
      />
    </>
  );
}

/** A quest's state badges in the room: hidden, pinned for Up next, paused, a skipped step (T-603b). */
function QuestBadges({
  language,
  hidden,
  pinned,
  quest,
}: Readonly<{ language: Language; hidden: boolean; pinned: boolean; quest: QuestView }>) {
  const t = useTranslator(language);
  return (
    <>
      {hidden ? <Badge tone="warning">{t("quests.hidden")}</Badge> : null}
      {pinned ? <Badge tone="info">{t("quests.pinned")}</Badge> : null}{" "}
      {quest.paused === true ? <Badge tone="warning">{t("control.quests.paused")}</Badge> : null}{" "}
      {quest.skipped === true ? (
        <Badge tone="info">{t("control.quests.skipped")}</Badge>
      ) : null}{" "}
    </>
  );
}

/** The pin for Up next and the pause and skip switches of one quest, while the event is open to change. */
function RowActions({
  language,
  quest,
  pinned,
  skippable,
  props,
}: Readonly<{
  language: Language;
  quest: QuestView;
  pinned: boolean;
  skippable: boolean;
  props: QuestsProps;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <Button
        variant="quiet"
        disabled={props.busy}
        aria-pressed={pinned}
        onClick={() => props.pin(quest)}
      >
        {t("quests.pin")}
      </Button>
      <SwitchButtons
        language={language}
        quest={quest}
        busy={props.busy}
        skippable={skippable}
        toggle={props.toggle}
      />
    </>
  );
}

/**
 * Every quest of the event with its completions and rate (FR-1024), the pin for Up next (FR-1748), and the flash and
 * live poll buttons that a quest of that kind has (FR-1025). Reuses the quest list's own controls and confirmations.
 */
export function ControlQuests(props: QuestsProps) {
  const { language, timeZone, categories, focusQuestId, done, players, busy } = props;
  const t = useTranslator(language);
  const quests = categories.flatMap((category) => category.quests);
  if (quests.length === 0) {
    return <EmptyState>{t("control.quests.empty")}</EmptyState>;
  }
  return (
    <Rows>
      {quests.map((quest) => {
        const pinned = focusQuestId === quest.id;
        const flash = flashStateOf({ ...quest, flash: quest.flash === true }, Date.now());
        const poll = isLivePoll(quest.type, quest.config);
        return (
          <Row
            key={quest.id}
            main={
              <>
                <strong dir="auto">{textFor(quest.title, language)}</strong>{" "}
                <QuestBadges
                  language={language}
                  hidden={!quest.visible && !poll && flash === null}
                  pinned={pinned}
                  quest={quest}
                />
                <QuestStats
                  language={language}
                  quest={quest}
                  done={done[quest.id]}
                  players={players}
                />
                {props.flashOn ? (
                  <FlashControls
                    language={language}
                    timeZone={timeZone}
                    quest={quest}
                    busy={busy}
                    readOnly={props.readOnly}
                    actions={props.actions}
                  />
                ) : null}
                <PollControls
                  language={language}
                  timeZone={timeZone}
                  quest={quest}
                  busy={busy}
                  readOnly={props.readOnly}
                  actions={props.actions}
                />
              </>
            }
          >
            {props.readOnly ? null : (
              <RowActions
                language={language}
                quest={quest}
                pinned={pinned}
                skippable={props.inOrder.has(quest.categoryId) && quest.flash !== true && !poll}
                props={props}
              />
            )}
          </Row>
        );
      })}
    </Rows>
  );
}
