import type { BannerSlide, ComposedConfig, OwnDaily, QuestifyHomeBlock } from "@questify/shared";
import { router } from "expo-router";
import { useCallback, type ReactNode } from "react";
import { AddEmailCard } from "#src/account/AddEmailCard.tsx";
import { usePlayer } from "#src/auth/player.tsx";
import { Button } from "#src/components/Controls.tsx";
import { DailyChallengeCard, DailyWordCard } from "#src/daily/DailyCards.tsx";
import type { TapOutcome } from "#src/event/home-content.ts";
import { BannerSlider, useOpenLink } from "#src/event/HomeBlocks.tsx";
import { CodeEntry } from "#src/home/CodeEntry.tsx";
import { bannerOutcome } from "#src/home/home-layout.ts";
import { Invitations } from "#src/home/Invitations.tsx";
import { MyEvents } from "#src/home/MyEvents.tsx";
import { PlatformNotices } from "#src/home/PlatformNotices.tsx";
import { StreakLine } from "#src/home/StreakLine.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { OperatorEvents } from "#src/operator/OperatorEvents.tsx";

/** The banner of Questify home: text slides whose tap opens nothing or a web link, after the player agrees. */
function QuestifyBanner({ slides }: Readonly<{ slides: readonly BannerSlide[] }>) {
  const openLink = useOpenLink();
  const open = useCallback(
    (outcome: TapOutcome) => {
      if (outcome.kind === "link") openLink(outcome);
    },
    [openLink],
  );
  return <BannerSlider slides={slides} outcomeOf={bannerOutcome} open={open} />;
}

function QuestsButton() {
  const { t } = useI18n();
  return (
    <Button
      kind="quiet"
      label={t("questifyQuests.title")}
      onPress={() => router.push("/questify-quests")}
    />
  );
}

/** The blocks only a signed-in player sees; a signed-out visitor sees the layout's other blocks and the sign-in prompt. */
const SIGNED_IN_BLOCKS: Readonly<
  Partial<Record<QuestifyHomeBlock, (daily: OwnDaily | null) => ReactNode>>
> = {
  account: () => <AddEmailCard />,
  operator: () => <OperatorEvents />,
  invitations: () => <Invitations />,
  streak: () => <StreakLine />,
  dailyChallenge: (daily) => <DailyChallengeCard daily={daily} />,
  dailyWord: (daily) => <DailyWordCard daily={daily} />,
  events: () => <MyEvents />,
  quests: () => <QuestsButton />,
};

/**
 * One block of Questify home (T-713, FR-1838). The layout decides which blocks are drawn and in what order; each block keeps
 * its own conditions (a streak the platform switched off, a game with nothing today, no invitations) and draws nothing then.
 */
export function HomeBlock({
  block,
  config,
  banner,
  daily,
}: Readonly<{
  block: QuestifyHomeBlock;
  config: ComposedConfig | undefined;
  banner: readonly BannerSlide[];
  daily: OwnDaily | null;
}>) {
  const { state } = usePlayer();
  if (block === "banner") return <QuestifyBanner slides={banner} />;
  if (block === "notices") return <PlatformNotices config={config} />;
  if (block === "code") return <CodeEntry />;
  return state.status === "signed_in" ? (SIGNED_IN_BLOCKS[block]?.(daily) ?? null) : null;
}
