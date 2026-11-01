"use client";

import type {
  CardLayout,
  EventLooks,
  Language,
  MessageKey,
  RankingLayout,
  RankingScores,
} from "@questify/shared";
import type { ReactNode } from "react";
import type { PreviewScreen } from "#src/components/PreviewScreens.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { FieldGroup, Radio } from "#src/ui/Field.tsx";
import { infoTip } from "#src/ui/info.tsx";
import { Section, Stack } from "#src/ui/Section.tsx";

type Choice<V extends string> = readonly [V, MessageKey];

const LIST_OR_GRID: readonly Choice<CardLayout>[] = [
  ["list", "looks.list"],
  ["grid", "looks.grid"],
];
const RANKING_LAYOUT_CHOICES: readonly Choice<RankingLayout>[] = [
  ["list", "looks.list"],
  ["podium", "looks.podium"],
];
const RANKING_SCORE_CHOICES: readonly Choice<RankingScores>[] = [
  ["shown", "looks.scoresShown"],
  ["rank_only", "looks.rankOnly"],
];

/** One setting: its words, the choices as radios, and a mark when the feature it styles is switched off for the event. */
function Setting<V extends string>({
  language,
  name,
  legend,
  info,
  choices,
  value,
  off,
  onPick,
}: Readonly<{
  language: Language;
  name: string;
  legend: string;
  info?: ReactNode;
  choices: readonly Choice<V>[];
  value: V;
  off: boolean;
  onPick: (choice: V) => void;
}>) {
  const t = useTranslator(language);
  return (
    <FieldGroup
      legend={
        <>
          {legend} {off ? <Badge>{t("layout.switchedOff")}</Badge> : null}
        </>
      }
      info={info}
      layout="choiceGrid"
    >
      {choices.map(([choice, label]) => (
        <Radio
          key={choice}
          name={name}
          checked={value === choice}
          onChange={() => onPick(choice)}
          label={t(label)}
        />
      ))}
    </FieldGroup>
  );
}

/**
 * How the ranking, Quests and Rewards screens are drawn (FR-1832, FR-1833, T-611): List or Podium and scores or places only
 * for the ranking, List or Grid for Quests and for Rewards. Choosing one shows that screen in the preview. A screen whose
 * feature is switched off is marked, since the switch wins over a layout.
 */
export function ScreenStyles({
  language,
  looks,
  on,
  onChange,
  onTouch,
}: Readonly<{
  language: Language;
  looks: EventLooks;
  on: (feature: string) => boolean;
  onChange: (looks: EventLooks) => void;
  onTouch: (screen: PreviewScreen) => void;
}>) {
  const t = useTranslator(language);
  const change = (next: EventLooks, screen: PreviewScreen) => {
    onChange(next);
    onTouch(screen);
  };
  const rankingOff = !on("ranking");
  return (
    <Section title={t("looks.title")}>
      <Stack>
        <Setting
          language={language}
          name="looks-ranking-layout"
          legend={t("looks.rankingLayout")}
          choices={RANKING_LAYOUT_CHOICES}
          value={looks.ranking.layout}
          off={rankingOff}
          onPick={(layout) =>
            change({ ...looks, ranking: { ...looks.ranking, layout } }, "ranking")
          }
        />
        <Setting
          language={language}
          name="looks-ranking-scores"
          legend={t("looks.rankingShows")}
          info={infoTip(t, "looks.rankOnlyInfo")}
          choices={RANKING_SCORE_CHOICES}
          value={looks.ranking.scores}
          off={rankingOff}
          onPick={(scores) =>
            change({ ...looks, ranking: { ...looks.ranking, scores } }, "ranking")
          }
        />
        <Setting
          language={language}
          name="looks-quests"
          legend={t("looks.questsLayout")}
          choices={LIST_OR_GRID}
          value={looks.quests}
          off={false}
          onPick={(quests) => change({ ...looks, quests }, "quests")}
        />
        <Setting
          language={language}
          name="looks-shop"
          legend={t("looks.rewardsLayout")}
          choices={LIST_OR_GRID}
          value={looks.shop}
          off={!on("shop")}
          onPick={(shop) => change({ ...looks, shop }, "rewards")}
        />
      </Stack>
    </Section>
  );
}
