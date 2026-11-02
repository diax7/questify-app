"use client";

import {
  formatNumber,
  type Language,
  type MessageKey,
  type PlatformNumbers,
} from "@questify/shared";
import { NUMBERS_API, readPlatformNumbers } from "#src/lib/console-platform.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Figure, PanelGrid, Tile } from "#src/ui/Charts.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, SubHeading } from "#src/ui/Section.tsx";

type Figures = readonly (readonly [MessageKey, number])[];

/** The groups of the page, each with its tiles: the figure's name and its number. */
function groupsOf(numbers: PlatformNumbers): readonly (readonly [MessageKey, Figures])[] {
  const { organizers, events, players, activity, staff } = numbers;
  return [
    [
      "console.numbers.group.organizers",
      [
        ["console.numbers.organizersActive", organizers.active],
        ["console.numbers.organizersPending", organizers.pending],
        ["console.numbers.organizersPaused", organizers.paused],
      ],
    ],
    [
      "console.numbers.group.events",
      [
        ["events.status.draft", events.draft],
        ["events.status.scheduled", events.scheduled],
        ["events.status.live", events.live],
        ["events.status.ended", events.ended],
        ["events.status.archived", events.archived],
        ["console.numbers.eventsSuspended", events.suspended],
      ],
    ],
    [
      "console.numbers.group.players",
      [
        ["console.numbers.playersActive", players.active],
        ["console.numbers.playersBanned", players.banned],
        ["console.numbers.playersJoinedWeek", players.joinedWeek],
      ],
    ],
    [
      "console.numbers.group.activity",
      [
        ["console.numbers.playersInLiveEvents", activity.playersInLiveEvents],
        ["console.numbers.entriesHour", activity.entriesHour],
      ],
    ],
    [
      "console.numbers.group.staff",
      [
        ["console.numbers.staffAccounts", staff.accounts],
        ["console.numbers.staffAdmins", staff.admins],
      ],
    ],
  ];
}

/**
 * The console's platform numbers (T-709, FR-1419): events, players, activity, organizers and staff as equal figure
 * tiles in groups. Counts only; zeros show as zeros on a platform with nothing yet. Platform admins only.
 */
export function ConsoleNumbers({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const { state, reload } = useConsoleRead(NUMBERS_API, readPlatformNumbers);
  return (
    <Stack as="section" aria-labelledby="console-numbers-title">
      <PageHeader
        titleId="console-numbers-title"
        title={t("console.numbers.title")}
        actions={<Button onClick={() => void reload()}>{t("console.health.refresh")}</Button>}
      />
      {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {state.kind === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("console.numbers.loadFailed")}{" "}
          <Button size="sm" onClick={() => void reload()}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {state.kind === "ready"
        ? groupsOf(state.value).map(([group, figures]) => (
            <Stack key={group}>
              <SubHeading as="h2">{t(group)}</SubHeading>
              <PanelGrid kind="tiles">
                {figures.map(([name, value]) => (
                  <Tile key={name} title={t(name)}>
                    <Figure>{formatNumber(value, language)}</Figure>
                  </Tile>
                ))}
              </PanelGrid>
            </Stack>
          ))
        : null}
    </Stack>
  );
}
