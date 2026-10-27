import { Ionicons } from "@expo/vector-icons";
import type { DailyChallenge, MessageKey, Theme } from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { PopIn } from "#src/components/motion.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { postAnswer } from "#src/daily/daily-api.ts";
import { stepAfterMove } from "#src/daily/daily-flow.ts";
import { nextLine } from "#src/daily/daily-lines.ts";
import { nextQuestion, withAnswer } from "#src/daily/daily-state.ts";
import { DailyGate } from "#src/daily/DailyGate.tsx";
import {
  useAfterFinish,
  useCelebrateWhen,
  useOwnDaily,
  type DailyRead,
} from "#src/daily/use-daily.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import type { LevelUp } from "#src/questify/level.ts";
import { ProfileGate } from "#src/questify/ProfileGate.tsx";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

type Question = DailyChallenge["questions"][number];

/** "Presented by {name}" under the title; a disclosed name only, no link and no logo (ADR-311). */
export function SponsorLine({ sponsor }: Readonly<{ sponsor: DailyChallenge["sponsor"] }>) {
  const { t, language } = useI18n();
  if (sponsor === null) return null;
  return <AppText muted>{t("daily.sponsor", { name: sponsor[language] })}</AppText>;
}

type OptionState = "idle" | "right" | "yours";

const OPTION_STATE_LABEL: Readonly<
  Record<
    Exclude<OptionState, "idle">,
    "daily.challenge.optionRight" | "daily.challenge.optionYours"
  >
> = { right: "daily.challenge.optionRight", yours: "daily.challenge.optionYours" };

/** The right option is marked by colour, a tick and a label; a wrong choice by a dashed border, a cross and a label. */
function Option(
  props: Readonly<{
    text: string;
    state: OptionState;
    disabled: boolean;
    onPress: () => void;
  }>,
) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const stateLabel = props.state === "idle" ? null : t(OPTION_STATE_LABEL[props.state]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        stateLabel === null
          ? props.text
          : t("daily.challenge.optionLabel", { text: props.text, state: stateLabel })
      }
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.option, props.state === "idle" ? null : styles[props.state]]}
    >
      <View style={styles.optionLine}>
        <AppText style={styles.optionText}>{props.text}</AppText>
        {props.state === "idle" ? null : (
          <Ionicons
            name={props.state === "right" ? "checkmark-circle" : "close-circle"}
            size={26}
            color={theme.colors.text}
          />
        )}
      </View>
      {stateLabel === null ? null : <AppText variant="label">{stateLabel}</AppText>}
    </Pressable>
  );
}

/** One question with its options; once answered the right option is marked by colour, an icon and a label. */
function QuestionView(
  props: Readonly<{
    question: Question;
    total: number;
    busy: boolean;
    last: boolean;
    onChoose: (choice: number) => void;
    onNext: () => void;
  }>,
) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const { question } = props;
  const answered = question.answered;
  return (
    <View style={styles.block}>
      <AppText variant="label" muted>
        {t("daily.challenge.question", { position: question.position, total: props.total })}
      </AppText>
      <AppText variant="title" accessibilityRole="header">
        {question.prompt[language]}
      </AppText>
      {question.options.map((option, index) => {
        const choice = index + 1;
        const state: OptionState =
          answered === null
            ? "idle"
            : choice === answered.right
              ? "right"
              : choice === answered.choice
                ? "yours"
                : "idle";
        return (
          <Option
            key={choice}
            text={option[language]}
            state={state}
            disabled={props.busy || answered !== null}
            onPress={() => props.onChoose(choice)}
          />
        );
      })}
      {answered === null ? null : (
        <View accessibilityLiveRegion="polite" style={styles.block}>
          <AppText variant="label">
            {t(answered.correct ? "daily.challenge.answerRight" : "daily.challenge.answerWrong")}
          </AppText>
          <Button
            label={t(props.last ? "daily.seeResult" : "daily.challenge.nextQuestion")}
            onPress={props.onNext}
          />
        </View>
      )}
    </View>
  );
}

/** The end card: the score, the XP and when the next challenge comes. */
function ResultCard({ challenge }: Readonly<{ challenge: DailyChallenge }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const finished = challenge.finished;
  if (finished === null) return null;
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <PopIn>
        <AppText variant="title" accessibilityRole="header">
          {t("daily.challenge.resultTitle")}
        </AppText>
        <AppText>
          {t("daily.challenge.resultScore", {
            correct: finished.correct,
            total: challenge.questions.length,
          })}
        </AppText>
        <AppText variant="display">{t("daily.xp", { xp: finished.xp })}</AppText>
        <AppText muted>{nextLine("challenge", challenge.period, new Date(), t)}</AppText>
      </PopIn>
    </View>
  );
}

/** Answering, the reveal that waits for "Next", and what each answer of the server does. */
function useAnswering(read: DailyRead, challenge: DailyChallenge) {
  const afterFinish = useAfterFinish();
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [levelUp, setLevelUp] = useState<LevelUp | null>(null);
  // The level-up card waits for Next or See result, so the last reveal is seen first.
  useCelebrateWhen(levelUp, challenge.finished !== null && pending === null, 0);
  const choose = async (question: Question, choice: number) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const outcome = await postAnswer(api.session, {
      challengeId: challenge.id,
      questionId: question.id,
      position: question.position,
      choice,
    });
    const step = stepAfterMove(outcome, "challenge");
    if (step.leave) {
      router.replace("/home");
      return;
    }
    if (outcome.kind === "ok") {
      const { reply } = outcome;
      read.update((current) =>
        current.challenge === null
          ? current
          : { ...current, challenge: withAnswer(current.challenge, reply) },
      );
      setPending(question.position);
      if (reply.finished !== null) {
        setLevelUp(reply.levelUp);
        afterFinish();
      }
    }
    setNotice(step.notice);
    if (step.reread) {
      setPending(null);
      await read.load();
    }
    setBusy(false);
  };
  return { pending, busy, notice, choose, next: () => setPending(null) };
}

function ChallengePlay({
  read,
  challenge,
}: Readonly<{ read: DailyRead; challenge: DailyChallenge }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const answering = useAnswering(read, challenge);
  const shown =
    answering.pending === null
      ? nextQuestion(challenge)
      : challenge.questions.find((question) => question.position === answering.pending);
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <SponsorLine sponsor={challenge.sponsor} />
      {answering.notice === null ? null : (
        <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>
          <AppText>{t(answering.notice)}</AppText>
        </View>
      )}
      {shown === undefined ? (
        <ResultCard challenge={challenge} />
      ) : (
        <QuestionView
          key={shown.id}
          question={shown}
          total={challenge.questions.length}
          busy={answering.busy}
          last={challenge.finished !== null}
          onChoose={(choice) => void answering.choose(shown, choice)}
          onNext={answering.next}
        />
      )}
    </ScrollView>
  );
}

function ChallengeBody() {
  const { t } = useI18n();
  const read = useOwnDaily();
  return (
    <DailyGate read={read}>
      {(daily) =>
        daily.challenge === null ? (
          <AppText muted>{t("daily.challenge.none")}</AppText>
        ) : (
          <ChallengePlay read={read} challenge={daily.challenge} />
        )
      }
    </DailyGate>
  );
}

/**
 * The daily challenge (T-406b, FR-730): three questions one at a time, each answer final; the right option is shown
 * after it. The end card gives the XP and the date of the next challenge; nothing counts down (ADR-300).
 */
export function DailyChallengeScreen() {
  const { t } = useI18n();
  const { state } = usePlayer();
  const me = state.status === "signed_in" ? state.me : undefined;
  return (
    <Screen title={t("daily.challenge.title")} header={<BackButton />}>
      {me === undefined ? <ProfileGate /> : <ChallengeBody key={me.id} />}
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  body: { gap: theme.spacing.md, paddingBottom: theme.spacing.xl },
  block: { gap: theme.spacing.md },
  option: {
    gap: theme.spacing.xs,
    minHeight: 56,
    justifyContent: "center" as const,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  right: {
    borderColor: theme.colors.primaryAction,
    backgroundColor: theme.colors.primaryAction,
  },
  // Dashed, so the wrong choice differs from the right one by more than its colour.
  yours: {
    borderColor: theme.colors.hot,
    borderStyle: "dashed" as const,
    backgroundColor: theme.colors.dangerSurface,
  },
  optionLine: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: theme.spacing.sm,
  },
  optionText: { flex: 1 },
  notice: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.surface,
  },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.xl,
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderColor: theme.colors.tierGold,
    backgroundColor: theme.colors.surface,
  },
});
