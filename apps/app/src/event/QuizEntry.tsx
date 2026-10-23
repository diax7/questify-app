import { formatNumber, termFor, type LocalizedText, type Theme } from "@questify/shared";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button, Problem } from "#src/components/Controls.tsx";
import { useReduceMotion } from "#src/components/motion.tsx";
import { bonusLine, completedText } from "#src/event/amount.ts";
import { ChoiceList } from "#src/event/ChoiceList.tsx";
import { useTerms } from "#src/event/EventContext.tsx";
import {
  REVEAL_WAIT_MS,
  announces,
  answerQuiz,
  fetchQuiz,
  quizAction,
  quizStage,
  secondsLeft,
  type PlayFailure,
  type QuizAnswered,
  type QuizQuestion,
  type QuizStep,
  type QuizView,
} from "#src/event/plays.ts";
import type { Quest } from "#src/event/quests-api.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Translate = ReturnType<typeof useI18n>["t"];
type Clock = Readonly<{ serverNow: string; receivedAt: number }>;

/** Haptics never block the quiz: a phone without them simply stays still. */
const buzz = (type: Haptics.NotificationFeedbackType) =>
  void Haptics.notificationAsync(type).catch(() => undefined);

/** The quiz's state and its three moves: load (read only), start or next, and answer. */
function useQuiz(questId: string, onPaid: () => void) {
  const [view, setView] = useState<QuizView | undefined | "failed">(undefined);
  const [clock, setClock] = useState<Clock>({ serverNow: new Date().toISOString(), receivedAt: 0 });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LocalizedText | "network" | null>(null);
  const [step, setStep] = useState<QuizStep | null>(null);

  const show = useCallback((quiz: QuizView) => {
    setView(quiz);
    setClock({ serverNow: quiz.serverNow, receivedAt: Date.now() });
  }, []);
  const load = useCallback(async () => {
    const quiz = await fetchQuiz(api.session, questId);
    if (quiz === undefined) {
      setView("failed");
      return;
    }
    show(quiz);
  }, [questId, show]);
  useEffect(() => {
    void load();
  }, [load]);

  const settle = (answer: QuizStep | PlayFailure) => {
    setBusy(false);
    if (answer.kind === "quiz") {
      const before = typeof view === "object" ? view.status : "none";
      const paidNow = answer.quiz.status === "finished" && before === "open";
      setStep(answer);
      show(answer.quiz);
      if (answer.result !== null) {
        buzz(
          answer.result.right
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Error,
        );
      }
      if (paidNow && answer.quiz.earned > 0) {
        onPaid();
      }
      return;
    }
    setProblem(
      answer.kind === "refused" ? answer.message : answer.kind === "network" ? "network" : null,
    );
    // A refusal (a question that closed, a quest that ended) reads the quiz again, so the screen shows what is true.
    void load();
  };
  const begin = () => {
    setBusy(true);
    setProblem(null);
  };
  return {
    view,
    clock,
    busy,
    problem,
    step,
    load,
    move: async (action: "start" | "next") => {
      begin();
      settle(await quizAction(api.session, questId, action, randomUuid()));
    },
    answer: async (questionId: string, choiceId: string) => {
      begin();
      settle(await answerQuiz(api.session, questId, { questionId, choiceId }, randomUuid()));
    },
  };
}

/** Seconds left, counted on the server's clock; at 0 it waits out the grace, then reads the closed question. */
function Countdown({
  question,
  clock,
  timer,
  onClosed,
}: Readonly<{ question: QuizQuestion; clock: Clock; timer: number; onClosed: () => void }>) {
  const { t } = useI18n();
  const reduce = useReduceMotion();
  const styles = useThemedStyles(makeStyles);
  const [left, setLeft] = useState(() => secondsLeft(question.closesAt, clock, Date.now()) ?? 0);
  useEffect(() => {
    const id = setInterval(() => {
      setLeft(secondsLeft(question.closesAt, clock, Date.now()) ?? 0);
    }, 1000);
    return () => clearInterval(id);
  }, [question.closesAt, clock]);
  useEffect(() => {
    if (announces(left)) {
      AccessibilityInfo.announceForAccessibility(t("play.quiz.secondsLeft", { seconds: left }));
    }
    if (left > 0) {
      return undefined;
    }
    const id = setTimeout(onClosed, REVEAL_WAIT_MS);
    return () => clearTimeout(id);
  }, [left, onClosed, t]);
  const text = left > 0 ? t("play.quiz.secondsLeft", { seconds: left }) : t("play.quiz.timeUp");
  return (
    <View style={styles.countdown}>
      {/* The bar is decoration: under Reduce Motion only the number shows. Screen readers hear it every 10 s. */}
      {reduce === false ? (
        <View style={styles.track} importantForAccessibility="no-hide-descendants">
          <View style={[styles.bar, { width: `${Math.round((100 * left) / timer)}%` }]} />
        </View>
      ) : null}
      <AppText variant="label" accessibilityLiveRegion="none">
        {text}
      </AppText>
    </View>
  );
}

/** Right, wrong or closed for one question, with the right answer's words (FR-209, FR-210). */
function revealText(answered: QuizAnswered, t: Translate, language: "ar" | "en"): string {
  const right = answered.choices.find((choice) => choice.id === answered.rightChoiceId);
  const answer = right === undefined ? "" : textIn(right.text, language);
  if (answered.right) {
    return t("play.quiz.right");
  }
  return answered.closed ? t("play.quiz.closed", { answer }) : t("play.quiz.wrong", { answer });
}

function Intro({
  quiz,
  open,
  busy,
  start,
}: Readonly<{ quiz: QuizView; open: boolean; busy: boolean; start: () => void }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  return (
    <>
      <AppText>{t("play.quiz.questions", { count: formatNumber(quiz.total, language) })}</AppText>
      <AppText>
        {t("play.quiz.perRight", {
          currency: termFor(terms.currency, language, quiz.pointsEach),
          points: formatNumber(quiz.pointsEach, language),
        })}
      </AppText>
      {quiz.timerSeconds === null ? null : (
        <AppText>
          {t("play.quiz.timer", { seconds: formatNumber(quiz.timerSeconds, language) })}
        </AppText>
      )}
      <AppText muted>{t("play.quiz.oneTry")}</AppText>
      {open ? (
        <Button
          label={quiz.status === "none" ? t("play.quiz.start") : t("play.quiz.resume")}
          disabled={busy}
          onPress={start}
        />
      ) : null}
    </>
  );
}

function Result({ quiz }: Readonly<{ quiz: QuizView }>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const right = formatNumber(quiz.rightCount, language);
  const total = formatNumber(quiz.total, language);
  if (quiz.status === "void") {
    return <AppText variant="label">{t("play.quiz.void")}</AppText>;
  }
  return (
    <>
      <AppText variant="label">{t("play.quiz.result", { right, total })}</AppText>
      <AppText>
        {quiz.earned > 0
          ? completedText(t, terms, language, quiz.earned)
          : t("play.quiz.noPoints", { currency: termFor(terms.currency, language) })}
      </AppText>
    </>
  );
}

/** The served question: where it stands, its words, its countdown and its choices. */
function QuestionStage({
  question,
  quiz,
  clock,
  busy,
  onClosed,
  onAnswer,
}: Readonly<{
  question: QuizQuestion;
  quiz: QuizView;
  clock: Clock;
  busy: boolean;
  onClosed: () => void;
  onAnswer: (choice: string) => void;
}>) {
  const { t, language } = useI18n();
  return (
    <>
      <AppText muted>
        {t("play.quiz.position", {
          position: formatNumber(question.position, language),
          total: formatNumber(quiz.total, language),
        })}
      </AppText>
      <AppText variant="label">{textIn(question.text, language)}</AppText>
      {quiz.timerSeconds === null ? null : (
        <Countdown
          key={question.id}
          question={question}
          clock={clock}
          timer={quiz.timerSeconds}
          onClosed={onClosed}
        />
      )}
      <ChoiceList choices={question.choices} chosen={null} disabled={busy} onChoose={onAnswer} />
    </>
  );
}

/** The question just answered or closed, with the right answer marked, and the way on. */
function RevealStage({
  answered,
  total,
  busy,
  onNext,
}: Readonly<{ answered: QuizAnswered; total: number; busy: boolean; onNext: () => void }>) {
  const { t, language } = useI18n();
  return (
    <>
      <AppText variant="label">{textIn(answered.text, language)}</AppText>
      <ChoiceList
        choices={answered.choices}
        chosen={answered.choiceId}
        disabled
        onChoose={() => undefined}
        marks={{ right: answered.rightChoiceId, wrong: answered.right ? null : answered.choiceId }}
      />
      <AppText accessibilityRole="alert">{revealText(answered, t, language)}</AppText>
      <Button
        label={answered.position < total ? t("play.quiz.next") : t("play.quiz.finish")}
        disabled={busy}
        onPress={onNext}
      />
    </>
  );
}

/**
 * A quiz quest in the quest sheet (FR-208 to FR-210): one question at a time from the server, one try, the right answer
 * after it, a countdown on the server's clock, and the result with what it paid. Reopening the sheet resumes.
 */
export function QuizEntry({ quest, onPaid }: Readonly<{ quest: Quest; onPaid: () => void }>) {
  const { t, language } = useI18n();
  const quiz = useQuiz(quest.id, onPaid);
  const { view } = quiz;
  if (view === undefined) {
    return null;
  }
  if (view === "failed") {
    return (
      <>
        <AppText accessibilityRole="alert">{t("play.loadFailed")}</AppText>
        <Button kind="quiet" label={t("common.retry")} onPress={() => void quiz.load()} />
      </>
    );
  }
  const stage = quizStage(view);
  const levelUp = quiz.step?.levelUp ?? null;
  const bonus = quiz.step?.bonus ?? null;
  return (
    <>
      {quiz.problem === "network" ? (
        <AppText accessibilityRole="alert">{t("join.network")}</AppText>
      ) : null}
      <Problem problem={quiz.problem === "network" ? null : quiz.problem} />
      {stage.kind === "intro" ? (
        <Intro
          quiz={view}
          open={quest.state === "open"}
          busy={quiz.busy}
          start={() => void quiz.move(view.status === "none" ? "start" : "next")}
        />
      ) : null}
      {stage.kind === "question" ? (
        <QuestionStage
          question={stage.question}
          quiz={view}
          clock={quiz.clock}
          busy={quiz.busy}
          onClosed={() => void quiz.load()}
          onAnswer={(choice) => void quiz.answer(stage.question.id, choice)}
        />
      ) : null}
      {stage.kind === "reveal" ? (
        <RevealStage
          answered={stage.answered}
          total={view.total}
          busy={quiz.busy}
          onNext={() => void quiz.move("next")}
        />
      ) : null}
      {stage.kind === "result" ? (
        <>
          {quiz.step?.result == null ? null : (
            <AppText accessibilityRole="alert">
              {revealText(view.answered.at(-1) as QuizAnswered, t, language)}
            </AppText>
          )}
          <Result quiz={view} />
          {bonus === null ? null : <AppText>{bonusLine(t, language, bonus)}</AppText>}
          {levelUp === null ? null : (
            <AppText>
              {t("level.upLine", { level: levelUp.level, title: levelUp.title[language] })}
            </AppText>
          )}
        </>
      ) : null}
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  countdown: { gap: theme.spacing.sm },
  track: {
    height: 8,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.border,
    overflow: "hidden" as const,
  },
  bar: { height: 8, backgroundColor: theme.colors.primaryAction },
});
