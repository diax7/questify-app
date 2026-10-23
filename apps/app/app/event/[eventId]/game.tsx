import {
  GAME_NAME_KEYS,
  catchV1,
  formatNumber,
  gameTarget,
  memoryMatchV1,
  slidePuzzleV1,
  tapRushV1,
  targetWords,
  type GameName,
  type MessageKey,
  type Theme,
} from "@questify/shared";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { PopIn } from "#src/components/motion.tsx";
import { useTerms } from "#src/event/EventContext.tsx";
import { levelLine, resendable, resultLine } from "#src/event/game-words.ts";
import {
  games,
  sendGameResult,
  windowOpen,
  type IssuedRound,
  type PendingResult,
  type ResultAnswer,
} from "#src/event/games.ts";
import { CatchGame } from "#src/games/CatchGame.tsx";
import { MemoryGame } from "#src/games/MemoryGame.tsx";
import { drawable, type Finished } from "#src/games/round.ts";
import { SlideGame } from "#src/games/SlideGame.tsx";
import { TapRushGame } from "#src/games/TapRushGame.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Stage =
  | Readonly<{ kind: "intro" }>
  | Readonly<{ kind: "play" }>
  | Readonly<{ kind: "sending" }>
  | Readonly<{ kind: "answered"; answer: ResultAnswer; pending: PendingResult }>;

/** The level's numbers for the round's own engine: the round's frozen params, read by that engine. */
function Board({
  round,
  onFinish,
}: Readonly<{ round: IssuedRound; onFinish: (done: Finished) => void }>) {
  const realtime = { deadlineAt: round.deadlineAt, offsetMs: round.offsetMs, onFinish };
  switch (round.game) {
    case "memory_match":
      return (
        <MemoryGame
          seed={round.seed}
          params={memoryMatchV1.params.parse(round.params)}
          onFinish={onFinish}
        />
      );
    case "slide_puzzle":
      return (
        <SlideGame
          seed={round.seed}
          params={slidePuzzleV1.params.parse(round.params)}
          onFinish={onFinish}
        />
      );
    case "catch":
      return (
        <CatchGame seed={round.seed} params={catchV1.params.parse(round.params)} {...realtime} />
      );
    case "tap_rush":
      return (
        <TapRushGame
          seed={round.seed}
          params={tapRushV1.params.parse(round.params)}
          {...realtime}
        />
      );
  }
}

/** How each game is played, in one line. */
const HOW_TO: Readonly<Record<GameName, MessageKey>> = {
  memory_match: "play.game.howTo.memoryMatch",
  slide_puzzle: "play.game.howTo.slidePuzzle",
  catch: "play.game.howTo.catch",
  tap_rush: "play.game.howTo.tapRush",
};

/** The round's time limit in seconds, read by its own engine. */
function secondsOf(round: IssuedRound): number {
  switch (round.game) {
    case "memory_match":
      return memoryMatchV1.params.parse(round.params).timeLimitSeconds;
    case "slide_puzzle":
      return slidePuzzleV1.params.parse(round.params).timeLimitSeconds;
    case "catch":
      return catchV1.params.parse(round.params).timeLimitSeconds;
    case "tap_rush":
      return tapRushV1.params.parse(round.params).timeLimitSeconds;
  }
}

/** The instruction card before the board (Arabic and English, mirrored; the board itself never mirrors). */
function Intro({ round, onStart }: Readonly<{ round: IssuedRound; onStart: () => void }>) {
  const { t, language } = useI18n();
  const seconds = secondsOf(round);
  const quick = round.game === "catch" || round.game === "tap_rush";
  return (
    <>
      <AppText muted>{levelLine(t, round.level)}</AppText>
      <AppText>{t(HOW_TO[round.game])}</AppText>
      {quick ? <AppText muted>{t("play.game.quickNote")}</AppText> : null}
      <AppText variant="label">
        {targetWords(t, gameTarget(round.game, round.params), language)}
      </AppText>
      <AppText muted>
        {t("play.game.timeLimit", { seconds: formatNumber(seconds, language) })}
      </AppText>
      <Button label={t("play.game.start")} onPress={onStart} />
    </>
  );
}

/**
 * A mini-game round, full screen (T-305, FR-1805, FR-1809): the instruction card, the board drawn from the round the
 * server issued, then the result sent with its inputs. A result that could not be sent stays in memory with Retry
 * until its window ends (on the server's clock); after that the round counted as played.
 */
export default function GameScreen() {
  const { roundId } = useLocalSearchParams<{ roundId: string }>();
  const { t, language, rtl } = useI18n();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  const round = games.round(String(roundId));
  const [stage, setStage] = useState<Stage>({ kind: "intro" });
  const navigation = useNavigation();
  const playing = stage.kind === "play";
  // Leaving mid-play (back, a swipe, the system button) asks first: the round already used its attempt.
  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    return navigation.addListener("beforeRemove", (leaving) => {
      leaving.preventDefault();
      Alert.alert(t("play.game.leaveTitle"), t("play.game.leaveBody"), [
        { text: t("play.game.keepPlaying"), style: "cancel" },
        {
          text: t("play.game.leave"),
          style: "destructive",
          onPress: () => navigation.dispatch(leaving.data.action),
        },
      ]);
    });
  }, [playing, navigation, t]);

  const send = async (pending: PendingResult) => {
    setStage({ kind: "sending" });
    const answer = windowOpen(pending, Date.now())
      ? await sendGameResult(api.session, pending)
      : ({ kind: "expired" } as const);
    if (!resendable(answer)) {
      games.dropResult(pending.questId);
    }
    setStage({ kind: "answered", answer, pending });
  };
  const finish = (done: Finished) => {
    if (round === undefined) {
      return;
    }
    const pending: PendingResult = {
      questId: round.questId,
      roundId: round.roundId,
      key: randomUuid(),
      inputs: done.inputs,
      claimed: done.claimed,
      deadlineAt: round.deadlineAt,
      offsetMs: round.offsetMs,
    };
    games.keepResult(pending);
    void send(pending);
  };

  if (round === undefined || !drawable(round.game, round.engineVersion)) {
    return (
      <SafeAreaView style={styles.page}>
        <View style={[styles.content, { direction: rtl ? "rtl" : "ltr" }]}>
          <AppText>{t(round === undefined ? "play.game.missing" : "play.game.update")}</AppText>
          <Button label={t("play.game.back")} onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={[styles.content, { direction: rtl ? "rtl" : "ltr" }]}>
        <AppText variant="title">{t(GAME_NAME_KEYS[round.game])}</AppText>
        {stage.kind === "intro" ? (
          <Intro round={round} onStart={() => setStage({ kind: "play" })} />
        ) : null}
        {stage.kind === "play" ? <Board round={round} onFinish={finish} /> : null}
        {stage.kind === "sending" ? <AppText muted>{t("play.game.sending")}</AppText> : null}
        {stage.kind === "answered" ? (
          <PopIn>
            <AppText accessibilityRole="alert">
              {resultLine(t, stage.answer, terms, language)}
            </AppText>
          </PopIn>
        ) : null}
        {stage.kind === "answered" && resendable(stage.answer) ? (
          <Button label={t("play.game.resend")} onPress={() => void send(stage.pending)} />
        ) : null}
        {stage.kind === "intro" || stage.kind === "answered" ? (
          <Button kind="quiet" label={t("play.game.back")} onPress={() => router.back()} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
});
